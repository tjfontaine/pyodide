export let suspenderGlobal = { value: null };
export let validSuspender = { value: false };

let promisingApplyHandler;
export function promisingApply(...args) {
  // validSuspender is a flag so that we can ask for permission before trying to
  // suspend.
  validSuspender.value = true;
  // Record the current stack position. Used in stack_state.mjs
  Module.stackStop = stackSave();
  return promisingApplyHandler(...args);
}

let promisingRunMainHandler;
export function promisingRunMain(...args) {
  // validSuspender is a flag so that we can ask for permission before trying to
  // suspend.
  validSuspender.value = true;
  // Record the current stack position. Used in stack_state.mjs
  Module.stackStop = stackSave();
  return promisingRunMainHandler(...args);
}

/**
 * This creates a wrapper around wasm_func that receives an extra suspender
 * argument and returns a promise. The suspender is stored into suspenderGlobal
 * so it can be used by syncify
 */
export function createPromising(wasm_func) {
  if (Module.newJspiSupported) {
    const promisingFunc = WebAssembly.promising(wasm_func);
    async function wrapper(...args) {
      const orig = validSuspender.value;
      validSuspender.value = true;
      try {
        return await promisingFunc(null, ...args);
      } finally {
        validSuspender.value = orig;
      }
    }
    return wrapper;
  }
  const { parameters } = wasmFunctionType(wasm_func);
  parameters.shift();
  return new WebAssembly.Function(
    { parameters, results: ["externref"] },
    wasm_func,
    { promising: "first" },
  );
}

/**
 * This sets up syncify to work.
 *
 * We need to make:
 *
 * - promisingApplyHandler which calls a Python function with stack switching
 *   enabled (used in callPyObjectKwargsSuspending in pyproxy.ts)
 */
export function initSuspenders() {
  // With ASYNCIFY=2 (JSPI) + MAIN_MODULE=1, wasmExports are wrapped by
  // Asyncify.instrumentWasmExports() before initSuspenders runs. The wrapped
  // functions are JS wrappers, not raw WASM exports, so WebAssembly.promising()
  // rejects them. Use Module._rawWasmExports (saved before instrumentation)
  // to get the original WASM exports.
  const exports = Module._rawWasmExports || wasmExports;
  promisingApplyHandler = createPromising(exports._pyproxy_apply_promising);
  if (exports.run_main_promising) {
    promisingRunMainHandler = createPromising(exports.run_main_promising);
  }
}
