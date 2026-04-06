/** @private */

import { PyodideConfigWithDefaults } from "./pyodide";
import { initializeNativeFS } from "./nativefs";
import { loadBinaryFile, getBinaryResponse } from "./compat";
import { API, PreRunFunc, type PyodideModule, type FSType } from "./types";
import { getJsvErrorImport } from "generated/jsverror";
import { RUNTIME_ENV } from "./environments";

/**
 * @private
 * @hidden
 */
export interface EmscriptenSettings {
  readonly noImageDecoding?: boolean;
  readonly noAudioDecoding?: boolean;
  readonly noWasmDecoding?: boolean;
  readonly preRun: readonly PreRunFunc[];
  readonly print?: (a: string) => void;
  readonly printErr?: (a: string) => void;
  readonly onExit?: (code: number) => void;
  readonly thisProgram?: string;
  readonly arguments: readonly string[];
  readonly instantiateWasm?: (
    imports: { [key: string]: any },
    successCallback: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => void;
  readonly API: API;
  readonly locateFile: (file: string) => string;

  noInitialRun?: boolean;
  INITIAL_MEMORY?: number;
  exitCode?: number;
}

/**
 * Get the base settings to use to load Pyodide.
 *
 * @private
 */
export function createSettings(
  config: PyodideConfigWithDefaults,
): EmscriptenSettings {
  const API = { config, runtimeEnv: RUNTIME_ENV } as API;
  const settings: EmscriptenSettings = {
    noImageDecoding: true,
    noAudioDecoding: true,
    noWasmDecoding: false,
    preRun: getFileSystemInitializationFuncs(config),
    print: config.stdout,
    printErr: config.stderr,
    onExit(code) {
      settings.exitCode = code;
    },
    thisProgram: config._sysExecutable,
    arguments: config.args,
    API,
    // Emscripten calls locateFile exactly one time with argument
    // pyodide.asm.wasm to get the URL it should download it from.
    //
    // If we set instantiateWasm the return value of locateFile actually is
    // unused, but Emscripten calls it anyways. We set instantiateWasm except
    // when compiling with source maps, see comment in getInstantiateWasmFunc().
    //
    // It also is called when Emscripten tries to find a dependency of a shared
    // library but it failed to find it in the file system. But for us that
    // means dependency resolution has already failed and we want to throw an
    // error anyways.
    locateFile: (path: string) => config.indexURL + path,
    instantiateWasm: getInstantiateWasmFunc(config.indexURL),
  };
  return settings;
}

/**
 * Make the home directory inside the virtual file system,
 * then change the working directory to it.
 *
 * @param Module The Emscripten Module.
 * @param path The path to the home directory.
 * @private
 */
function createHomeDirectory(path: string): PreRunFunc {
  // With WasmFS + ASYNCIFY, native FS functions don't work during preRun.
  // Use addRunDependency to block callMain, await to yield until runtime is
  // initialized, then do the FS work.
  return async function (Module) {
    Module.addRunDependency("create-home");
    try {
      // Yield so initRuntime() runs before we touch the filesystem
      await Promise.resolve();
      const fallbackPath = "/";
      try {
        Module.FS.mkdirTree(path);
      } catch (e) {
        console.error(`Error making home directory '${path}':`, e);
        path = fallbackPath;
      }
      try {
        Module.FS.chdir(path);
      } catch (_) { /* ignore */ }
    } finally {
      Module.removeRunDependency("create-home");
    }
  };
}

function setEnvironment(env: { [key: string]: string }): PreRunFunc {
  return function (Module) {
    Object.assign(Module.ENV, env);
  };
}

/**
 * Mount local directories to the virtual file system. Only for Node.js.
 * @param mounts The list of paths to mount.
 */
function callFsInitHook(
  fsInit: undefined | ((fs: FSType, info: { sitePackages: string }) => void),
): PreRunFunc[] {
  if (!fsInit) {
    return [];
  }
  return [
    async (Module) => {
      Module.addRunDependency("fsInitHook");
      try {
        await fsInit(Module.FS, { sitePackages: Module.API.sitePackages });
      } finally {
        Module.removeRunDependency("fsInitHook");
      }
    },
  ];
}

function computeVersionTuple(Module: PyodideModule): [number, number, number] {
  const versionInt = Module.HEAPU32[Module._Py_Version >>> 2];
  const major = (versionInt >>> 24) & 0xff;
  const minor = (versionInt >>> 16) & 0xff;
  const micro = (versionInt >>> 8) & 0xff;
  return [major, minor, micro];
}
/**
 * Install the Python standard library to the virtual file system.
 *
 * Previously, this was handled by Emscripten's file packager (pyodide.asm.data).
 * However, using the file packager means that we have only one version
 * of the standard library available. We want to be able to use different
 * versions of the standard library, for example:
 *
 * - Use compiled(.pyc) or uncompiled(.py) standard library.
 * - Remove unused modules or add additional modules using bundlers like pyodide-pack.
 *
 * @param stdlibURL The URL for the Python standard library
 */
function installStdlib(stdlibURL: string): PreRunFunc {
  const stdlibPromise: Promise<Uint8Array> = loadBinaryFile(stdlibURL);
  return async (Module: PyodideModule) => {
    // Don't call any native FS functions synchronously during preRun —
    // with WasmFS + ASYNCIFY, the runtime isn't initialized yet.
    // The addRunDependency blocks callMain. After the await below,
    // the runtime will be initialized and FS calls work.
    Module.addRunDependency("install-stdlib");

    try {
      const stdlib = await stdlibPromise;
      // After await, the event loop has ticked and initRuntime() has run.
      // WasmFS is now initialized — safe to call FS methods.
      Module.API.pyVersionTuple = computeVersionTuple(Module);
      const [pymajor, pyminor] = Module.API.pyVersionTuple;
      Module.FS.mkdirTree("/lib");
      Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
      Module.FS.mkdirTree(Module.API.sitePackages);
      Module.FS.writeFile(`/lib/python${pymajor}${pyminor}.zip`, stdlib);
    } catch (e) {
      console.error("Error occurred while installing the standard library:");
      console.error(e);
    } finally {
      Module.removeRunDependency("install-stdlib");
    }
  };
}

/**
 * Initialize the virtual file system, before loading Python interpreter.
 * @private
 */
function getFileSystemInitializationFuncs(
  config: PyodideConfigWithDefaults,
): PreRunFunc[] {
  // With WasmFS + ASYNCIFY=2, native FS functions don't work during preRun
  // (WasmFS isn't initialized until initRuntime). Use preRun only for pure JS
  // setup and addRunDependency. The actual FS work happens via preMain callbacks
  // which fire AFTER initRuntime but BEFORE callMain.
  let stdLibURL = config.stdLibURL ?? config.indexURL + "python_stdlib.zip";
  const stdlibPromise: Promise<Uint8Array> = loadBinaryFile(stdLibURL);

  return [
    (Module: PyodideModule) => {
      // Block callMain until FS is ready
      Module.addRunDependency("wasmfs-stdlib");

      // Pure JS setup (no native calls)
      Object.assign(Module.ENV, config.env);
      initializeNativeFS(Module);

      // Polyfill missing FS methods for WasmFS compatibility with Pyodide
      if (!Module.FS.closeStream) {
        Module.FS.closeStream = (_fd: number) => {
          // WasmFS doesn't have closeStream — streams are managed internally.
          // This is called by Pyodide's refreshStreams to reopen stdin/stdout/stderr.
          // No-op is safe because WasmFS manages fd lifecycle automatically.
        };
      }
      if (!Module.FS.getStream) {
        (Module.FS as any).getStream = (_fd: number) => null;
      }

      // Use addOnPreMain to register a callback that fires AFTER initRuntime
      // (WasmFS ready) but BEFORE callMain (Python needs stdlib).
      // The stdlib is fetched async and cached; the preMain callback installs it.
      let cachedStdlib: Uint8Array | null = null;
      stdlibPromise.then(stdlib => { cachedStdlib = stdlib; });

      const M = Module as any;
      M.addOnPreMain(() => {
        // initRuntime has run — WasmFS is initialized. Install stdlib.
        const [pymajor, pyminor] = computeVersionTuple(Module);
        Module.API.pyVersionTuple = [pymajor, pyminor, 0];
        Module.FS.mkdirTree("/lib");
        Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
        Module.FS.mkdirTree(Module.API.sitePackages);

        if (cachedStdlib) {
          Module.FS.writeFile(`/lib/python${pymajor}${pyminor}.zip`, cachedStdlib);
        } else {
          console.error("[WasmFS] stdlib not yet fetched when preMain fired!");
        }

        const homePath = config.env.HOME || "/home/pyodide";
        try { Module.FS.mkdirTree(homePath); } catch (_) {}
        try { Module.FS.chdir(homePath); } catch (_) {}
      });

      // Keep the run dependency until stdlib is fetched
      stdlibPromise.then(() => {
        Module.removeRunDependency("wasmfs-stdlib");
      }).catch(e => {
        console.error("[WasmFS] stdlib fetch error:", e);
        Module.removeRunDependency("wasmfs-stdlib");
      });
    },
  ];
}

/**
 * Initialize the filesystem after the WASM runtime is ready.
 * @private
 */
export async function initFilesystemPostRuntime(
  Module: PyodideModule,
  config: PyodideConfigWithDefaults,
): Promise<void> {
  // At this point _createPyodideModule has resolved, initRuntime() has run,
  // and WasmFS is initialized. But callMain hasn't run (noInitialRun: true).
  // We install stdlib, create dirs, mount OPFS, then call main manually.

  // 1. NativeFS (no-op with WasmFS)
  initializeNativeFS(Module);

  // 2. Environment
  Object.assign(Module.ENV, config.env);

  // 3. Install stdlib
  let stdLibURL = config.stdLibURL ?? config.indexURL + "python_stdlib.zip";
  const [pymajor, pyminor] = computeVersionTuple(Module);
  Module.API.pyVersionTuple = [pymajor, pyminor, 0];
  Module.FS.mkdirTree("/lib");
  Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
  Module.FS.mkdirTree(Module.API.sitePackages);

  const stdlib = await loadBinaryFile(stdLibURL);
  Module.FS.writeFile(`/lib/python${pymajor}${pyminor}.zip`, stdlib);

  // 4. Home directory
  const homePath = config.env.HOME || "/home/pyodide";
  try { Module.FS.mkdirTree(homePath); } catch (_) {}
  try { Module.FS.chdir(homePath); } catch (_) {}

  // 5. fsInit hook
  if (config.fsInit) {
    await config.fsInit(Module.FS, { sitePackages: Module.API.sitePackages });
  }

  // 6. Mount OPFS at /opfs via promising-wrapped raw WASM exports.
  // The new JSPI API (WebAssembly.promising) does NOT prepend a suspender arg.
  try {
    const rawExports = (Module as any)._rawWasmExports;
    if (rawExports?.wasmfs_create_opfs_backend) {
      const promising = (WebAssembly as any).promising;
      const createOpfs = promising(rawExports.wasmfs_create_opfs_backend);
      const opfs = await createOpfs();
      if (opfs) {
        // Mount OPFS at /home/user — this maps to navigator.storage.getDirectory().
        // The shell's OPFS root is /, so shell's /foo.txt = Python's /home/user/foo.txt.
        // This avoids a confusing /opfs prefix and matches the shell's home directory.
        const M = Module as any;
        const mountPath = "/home/user";
        const pathBytes = new TextEncoder().encode(mountPath + "\0");
        const pathPtr = M._malloc(pathBytes.length);
        M.HEAPU8.set(pathBytes, pathPtr);
        const mountFn = promising(rawExports._wasmfs_mount);
        const ret = await mountFn(pathPtr, opfs);
        M._free(pathPtr);
        if (ret < 0) {
          console.warn("[PyodideLoader] OPFS mount returned:", ret);
        } else {
          console.log("[PyodideLoader] OPFS mounted at " + mountPath);
        }
      }
    }
  } catch (e) {
    console.warn("[PyodideLoader] Could not mount OPFS:", e);
  }

  // Polyfills should already be set from preRun, but ensure they're present
  if (!Module.FS.closeStream) {
    Module.FS.closeStream = () => {};
  }
  if (!Module.FS.getStream) {
    (Module.FS as any).getStream = () => null;
  }
}

function getInstantiateWasmFunc(
  indexURL: string,
): EmscriptenSettings["instantiateWasm"] {
  // @ts-ignore
  if (SOURCEMAP || typeof WasmOffsetConverter !== "undefined") {
    // According to the docs:
    //
    // "Sanitizers or source map is currently not supported if overriding
    // WebAssembly instantiation with Module.instantiateWasm."
    // https://emscripten.org/docs/api_reference/module.html?highlight=instantiatewasm#Module.instantiateWasm
    //
    // typeof WasmOffsetConverter !== "undefined" checks for asan.
    return;
  }
  const { binary, response } = getBinaryResponse(indexURL + "pyodide.asm.wasm");
  const jsvErrorImportPromise = getJsvErrorImport();
  return function (
    imports: { [key: string]: { [key: string]: any } },
    successCallback: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) {
    (async function () {
      const { Jsv_GetError_import, JsvError_Check } =
        await jsvErrorImportPromise;
      imports.env.Jsv_GetError_import = Jsv_GetError_import;
      imports.env.JsvError_Check = JsvError_Check;
      try {
        let res: WebAssembly.WebAssemblyInstantiatedSource;
        if (response) {
          res = await WebAssembly.instantiateStreaming(response, imports);
        } else {
          res = await WebAssembly.instantiate(await binary, imports);
        }
        const { instance, module } = res;
        successCallback(instance, module);
      } catch (e) {
        console.warn("wasm instantiation failed!");
        console.warn(e);
      }
    })();

    return {}; // Compiling asynchronously, no exports.
  };
}
