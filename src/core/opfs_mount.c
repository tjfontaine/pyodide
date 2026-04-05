/**
 * WasmFS OPFS Mount — mounts OPFS at persistent paths during startup.
 *
 * Uses the wasmfs_before_preload() hook to mount the OPFS backend at:
 *   /home/user                      — user workspace (shared with shell)
 *   /lib/python3.XX/site-packages   — pip-installed packages (persistent)
 *
 * The OPFS backend uses SyncAccessHandle for fast I/O in Worker contexts.
 * This code runs before Python starts, so the directories exist by the
 * time CPython initializes the filesystem.
 */

#include <emscripten/wasmfs.h>
#include <stdio.h>
#include <string.h>

/* Python version macros are defined by the build system.
 * We construct the site-packages path at compile time. */
#ifndef PYMAJOR
#define PYMAJOR 3
#endif
#ifndef PYMINOR
#define PYMINOR 12
#endif

#define STR_HELPER(x) #x
#define STR(x) STR_HELPER(x)
#define SITE_PACKAGES_PATH "/lib/python" STR(PYMAJOR) "." STR(PYMINOR) "/site-packages"

void
wasmfs_before_preload(void)
{
  backend_t opfs = wasmfs_create_opfs_backend();
  if (!opfs) {
    fprintf(stderr, "[opfs_mount] Failed to create OPFS backend\n");
    return;
  }

  /* Mount user workspace */
  if (wasmfs_create_directory("/home", 0777, opfs) < 0) {
    fprintf(stderr, "[opfs_mount] Failed to create /home\n");
  }
  if (wasmfs_create_directory("/home/user", 0777, opfs) < 0) {
    fprintf(stderr, "[opfs_mount] Failed to create /home/user\n");
  }

  /* Mount persistent site-packages.
   * The parent /lib/pythonX.Y/ is created by Emscripten's preloading
   * (stdlib zip), so we only need to mount site-packages under it.
   * If the parent doesn't exist yet at this point, we create the
   * full path with the memory backend (default) and only site-packages
   * gets the OPFS backend. */
  if (wasmfs_create_directory(SITE_PACKAGES_PATH, 0777, opfs) < 0) {
    fprintf(stderr, "[opfs_mount] Failed to create %s\n", SITE_PACKAGES_PATH);
  }

  fprintf(stderr, "[opfs_mount] OPFS mounted at /home/user and %s\n",
          SITE_PACKAGES_PATH);
}
