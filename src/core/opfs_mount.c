/**
 * WasmFS OPFS Mount — mounts OPFS at persistent paths during startup.
 *
 * Uses the wasmfs_before_preload() hook to mount the OPFS backend at:
 *   /opfs — maps to navigator.storage.getDirectory() (OPFS root)
 *
 * The shell's filesystem root (/) corresponds to the OPFS root, so:
 *   shell's /foo.txt  =  Python's /opfs/foo.txt
 *
 * With ASYNCIFY=2 (JSPI), the OPFS backend can make async JS calls
 * synchronously without needing pthreads.
 */

#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <sys/stat.h>

__attribute__((constructor))
EMSCRIPTEN_KEEPALIVE void
wasmfs_before_preload(void)
{
  backend_t opfs = wasmfs_create_opfs_backend();
  if (!opfs) {
    fprintf(stderr, "[opfs_mount] Failed to create OPFS backend\n");
    return;
  }

  if (wasmfs_create_directory("/opfs", 0777, opfs) < 0) {
    fprintf(stderr, "[opfs_mount] Failed to create /opfs\n");
  }

  fprintf(stderr, "[opfs_mount] OPFS mounted at /opfs\n");
}
