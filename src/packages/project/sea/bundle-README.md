# CoCalc Project Bundle (Linux, glibc)

This bundle is the runtime payload for the CoCalc project process.
It is designed for **Linux (glibc)** and includes native addons for
both **x86_64** and **arm64** so a single tarball works across both
architectures.

Contents (high level):
- bundle/                  : JS runtime (ncc output) + supporting assets
- bundle/build/            : zeromq native addons + manifest.json (glibc only)
- bundle/node_modules/     : native addon packages (node-pty, bufferutil, utf-8-validate)
- src/packages/project/bin : helper scripts used by the runtime

Native addons:
- zeromq: bundle/build/linux/<arch>/node/glibc-*/addon.node
- node-pty: bundle/node_modules/@lydell/node-pty-linux-*/prebuilds/.../pty.node

This bundle intentionally excludes darwin/win32 payloads and musl builds
to keep size small and avoid irrelevant binaries.
