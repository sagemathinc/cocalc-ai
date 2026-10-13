# CoCalc Lite (Plus): the same distribution approach?

Status: decided and implemented as Phase A, Oct 13, 2026 (branch `feat/plus-dist-phase-a`, stacked on #1043). Builds on the CLI design (`cli-distribution-2026-10-12.md`) and its Phase A implementation (#1043).

## William's decisions (Oct 13)

1. **Served from software.cocalc.ai.** There is no link between cocalc-lite and a hub, so releases live in the release store at software.cocalc.ai/software/plus. The client reads it directly: `current.json`, `manifests/<sha>.json`, `files/<sha>`. A generated `install.sh` is published with each release.
2. **Lite never restarts automatically,** because that could lose data or state (notebook kernels, terminals).
   - Updates download and install in the background, at most every 6 hours while Lite runs.
   - They take effect the next time Lite starts.
   - The UI shows a "Restart to update" pill (the existing update indicator) whose action explains how to restart.
3. **A data snapshot, one previous version.** Whenever a different release first uses the data, the data directory is copied (with reflinks where the filesystem supports them) to `data.snapshot`, replacing the previous snapshot.
   - A rollback to that release restores it.
   - The newer data is kept once, as `data.replaced`.

## What was built

- **Release format:** `cocalc-plus-release/1` (`util/cli-distribution/plus-schema.ts`). It is strict and canonical like the CLI's, and lists a pinned Node, launcher and bootstrap, plus these zstd-compressed tars:
  - `app/<platform>`: the Lite bundle with that platform's native modules;
  - `tools/<platform>`: rg, fd and ouch, plus this build's CLI;
  - `static` and `public`.
- **On the user's machine** (`cli/src/distribution/plus.ts`):
  - Parts are kept by hash in `blobs/` and assembled once into `apps/<manifest>/`, verified at install (like Node).
  - It reuses the CLI's lock, floors, journaled switch, rollback hold and fault points.
  - Every running process holds a pin (`running/<pid>`), and garbage collection keeps whatever a live pin uses, so a running Lite's release is never removed.
  - Rollback is refused while a Lite server is running.
- **Launcher and bootstrap** (`plus/dist-release`): the bootstrap checks the manifest binding, pins the process, puts the tools and the pinned Node on `PATH`, and runs Lite as the main module.
- **Commands:** `cocalc-plus update [--check | --rollback | --resume | --auto on|off]`.
- **Releasing:**
  - `pnpm --dir src/packages/plus release:plus`, or the "Release CoCalc Plus (bundle)" workflow.
  - It builds each platform, then publishes with the CLI's publisher (compare-and-swap included) and writes `install.sh` last.
- **Compression:** zstd level 19 (as small as xz). Users unpack with Node's built-in zstd, so they need no `xz` or `zstd` tool.

Measured: app about 12 MB per platform, static 13 MB, public 23 MB. A typical update downloads one app part (about 12 MB), compared with 185 MB for the old single-file executable.

## Short answer

Yes. The native modules are not a blocker: every one of them is N-API, so a prebuild depends only on OS, architecture and libc, never on the Node version. Plus also needs three things the CLI doesn't:
- **More pieces per release:** assets, natives and tools, not a single file.
- **Restarting a long-running server** onto a new release.
- **Rollback that respects its local SQLite data.**

## What Plus ships today

- **One self-extracting SEA per platform,** 183–189 MB.
- **The published channel is stale:** `latest` is from July 1, 2026, the same drift problem the CLI had.
- **The installer also fetches `tools-minimal`** (rg, fd, ouch; 2.7–5.5 MB).

What is inside, measured from `plus/sea/build-bundle.sh` on linux-x64:

| Piece | Raw | xz | Changes |
|---|---|---|---|
| Node 26 (official archive) | ~120 MB | 30–63 MB (.tar.gz) | rarely; the **same pinned Node as the CLI** |
| `bundle/index.js` and its JS deps (ncc of Lite; not minified) | 164 MB | **12 MB** | every release |
| `static/` (frontend, no source maps) | 66 MB | 12 MB | most releases |
| `public/` (images, fonts) | 30 MB | 23 MB | rarely |
| Native addons (one platform) | a few MB | small | rarely |
| tools-minimal (rg, fd, ouch) | 3–6 MB | already an artifact | rarely |

## The native modules

| Module | Kind | Notes |
|---|---|---|
| `node-pty` 1.2 (beta) | N-API (node-addon-api), prebuilds for darwin, linux and win32 on x64 and arm64 | darwin also needs `spawn-helper` |
| `zeromq` 6.5 | N-API (cmake-ts loader) | ships builds for several ABIs, but they load through N-API |
| `cocalc_openat2` | our own napi-rs crate, Linux only | we build it per platform |
| `bufferutil`, `utf-8-validate` | N-API, optional for `ws` | `ws` has a pure-JS fallback, so they could be dropped |

**Verified on m1 (macOS 26, arm64):**
- Node 26.11.1 from the official archive loaded the upstream `node-pty` prebuild and ran a pty (`pty-ok`).
- It loaded `zeromq` and bound a socket.
- Nothing was signed or notarized by us: the files were fetched with plain HTTP, so they carry no quarantine attribute, and the pty prebuild is upstream's ad-hoc signed build.

So, unlike the SEA, **there is no Mach-O of ours to sign**. That removes the macOS signing and notarization step from Plus releases too.

## How it would map onto the CLI machinery

- **The same mechanics:**
  - a launcher, a pinned Node, content-addressed files, a manifest;
  - an exact `active` pointer and the journaled switch;
  - the numbered-slot lock;
  - floors and rollback with a hold;
  - automatic updates from the install origin, with the same trust statement.
- **One shared Node:** CLI and Plus pin the same Node, so `node/<sha>` is shared on disk and downloaded once.
- **The manifest lists components rather than one bundle,** each `{sha256, size, platform?, unpack}`:
  - `app` (bundle tarball), `static`, `public`;
  - `native-<platform>`, `tools-<platform>`.
  
  A JS-only release then downloads about 12 MB. `public` (23 MB) and Node (30+ MB) are reused when unchanged. That compares with 185 MB for every SEA update today.
- **Assembling the app tree:**
  - The installer assembles `apps/<manifest>/` from the verified components (hardlinks where possible), and verifies it once at install.
  - The bootstrap checks the manifest binding and the app's entry file at launch, but doesn't re-hash 200+ MB of assets on every start (as with Node in the CLI).
- **Install paths:** `curl -fsSL <site>/plus/install.sh | sh`, or `cocalc plus install` from an installed CLI, which reuses its Node and launcher machinery.
- **Phase A trust** is the same as the CLI's: the origin is fully trusted. **Phase B signing** matters a little sooner, because Plus is usually installed from software.cocalc.ai or its CDN, not from a hub the person uses.

## What is new for Plus

1. **A long-running server.** Updating must never swap code under a running Lite.
   - The server pins its release: a running pin with its PID and manifest, which GC treats as a root, like the computers record.
   - The new release takes effect on restart.
   - The UI shows "an update is ready, restart to apply". Lite could also restart itself when idle, with the same barrier idea as the computers daemon (admission closed, no running work).
2. **Local data and rollback.** Lite keeps SQLite databases (the ACP queue, jobs and runtime, artifacts, the personal library) and applies migrations.
   - A rollback across a schema change can break.
   - Releases should declare the data-schema version they need. Rollback refuses, with a clear message, to go below a schema the data has already been migrated to.
   - A data snapshot before each migrating update would allow rollback after all, at the cost of disk.
3. **Startup cost.** The unminified 150 MB `index.js` is parsed on every start.
   - Minifying it (as the CLI bundle does) and Node's compile cache (`NODE_COMPILE_CACHE`) should cut startup substantially. This is worth measuring before and after.
4. **Windows and Electron.** Plus has a Windows build (`build-cocalc-plus-windows.yml`) and an Electron entry.
   - Windows needs the native launcher planned for the CLI's later phase (`node.exe`, `conpty.node`, a `.cmd` or small exe launcher).
   - Electron is a separate product and keeps its own updater.
5. **libc.** Plus targets glibc Linux; musl (Alpine) would need musl natives and Node's musl build. Defer, as for the CLI.

## Suggested order

1. Land the CLI (#1043) and run it for a while; it proves the mechanics.
2. Generalize the manifest to components, using schema `cocalc-cli-release/2`, or a separate `cocalc-plus-release/1` sharing the code.
3. **Plus Phase A:** Linux and macOS, release with one command, the server pin plus "restart to apply", the schema-version guard on rollback, and a minified bundle.
4. Windows, with the CLI's Windows launcher.

## Open questions (for William)

- Should Plus be served by every hub (`/plus/*`, like `/cli/*`), or only from software.cocalc.ai or cocalc.ai?
- Should Lite apply updates when idle on its own, or only after "restart to apply"?
- Is a data snapshot before migrating updates (so rollback stays possible) worth the disk space?
