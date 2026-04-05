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
  return function (Module) {
    const fallbackPath = "/";
    try {
      Module.FS.mkdirTree(path);
    } catch (e) {
      console.error(`Error occurred while making a home directory '${path}':`);
      console.error(e);
      console.error(`Using '${fallbackPath}' for a home directory instead`);
      path = fallbackPath;
    }
    Module.FS.chdir(path);
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
    Module.API.pyVersionTuple = computeVersionTuple(Module);
    const [pymajor, pyminor] = Module.API.pyVersionTuple;
    Module.FS.mkdirTree("/lib");
    Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
    Module.FS.mkdirTree(Module.API.sitePackages);
    Module.addRunDependency("install-stdlib");

    try {
      const stdlib = await stdlibPromise;
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
  _config: PyodideConfigWithDefaults,
): PreRunFunc[] {
  // With WasmFS+JSPI, native FS functions aren't available during preRun.
  return [];
}

/**
 * Initialize the filesystem after the WASM runtime is ready.
 * @private
 */
export async function initFilesystemPostRuntime(
  Module: PyodideModule,
  config: PyodideConfigWithDefaults,
): Promise<void> {
  initializeNativeFS(Module);
  Object.assign(Module.ENV, config.env);

  let homePath = config.env.HOME || "/home/pyodide";
  try { Module.FS.mkdirTree(homePath); } catch (e) {
    console.error(`Error making home '${homePath}':`, e);
    homePath = "/";
  }
  try { Module.FS.chdir(homePath); } catch (e) {
    console.error(`Error chdir to '${homePath}':`, e);
  }

  let stdLibURL = config.stdLibURL ?? config.indexURL + "python_stdlib.zip";
  const [pymajor, pyminor] = computeVersionTuple(Module);
  Module.API.pyVersionTuple = [pymajor, pyminor, 0];
  try { Module.FS.mkdirTree("/lib"); } catch (_) {}
  Module.API.sitePackages = `/lib/python${pymajor}.${pyminor}/site-packages`;
  try { Module.FS.mkdirTree(Module.API.sitePackages); } catch (_) {}

  try {
    const stdlib = await loadBinaryFile(stdLibURL);
    Module.FS.writeFile(`/lib/python${pymajor}${pyminor}.zip`, stdlib);
  } catch (e) {
    console.error("Error installing stdlib:", e);
  }

  // 6. Mount OPFS at /opfs via WasmFS OPFS backend.
  // The OPFS backend makes async JS calls (navigator.storage.getDirectory),
  // so it must be called through a WebAssembly.promising()-wrapped function
  // to enable JSPI suspension. We wrap the raw WASM export directly.
  try {
    const rawExports = (Module as any)._rawWasmExports;
    if (rawExports?.wasmfs_create_opfs_backend) {
      const promising = (WebAssembly as any).promising;
      const createOpfs = promising(rawExports.wasmfs_create_opfs_backend);
      const createDir = promising(rawExports.wasmfs_create_directory);
      const opfs = await createOpfs(null);
      if (opfs) {
        const pathPtr = (Module as any).stringToUTF8OnStack("/opfs");
        await createDir(null, pathPtr, 0o777, opfs);
        console.log("[PyodideLoader] OPFS mounted at /opfs");
      } else {
        console.warn("[PyodideLoader] Failed to create OPFS backend");
      }
    }
  } catch (e) {
    console.warn("[PyodideLoader] Could not mount OPFS:", e);
  }

  if (config.fsInit) {
    await config.fsInit(Module.FS, { sitePackages: Module.API.sitePackages });
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
