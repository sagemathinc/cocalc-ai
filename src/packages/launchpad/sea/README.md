# CoCalc Launchpad Single Executable Build

This packages a self-extracting CoCalc Launchpad executable using
[Node.js single executable applications](https://nodejs.org/api/single-executable-applications.html).

Use the repository's normal build prerequisites and installed workspace
dependencies. The SEA builder requires Node.js 26 and supports Linux and macOS
in `build-sea.sh`. Put Node.js 26 on `PATH`; `COCALC_SEA_NODE_BIN` can select the
Node binary used for injection. A Node version manager is optional.

From the repository root, build the payload and executable with:

```sh
pnpm --dir src/packages/launchpad sea
```

If `src/packages/launchpad/build/bundle.tar.xz` has already been built, run just
the SEA step from its own directory:

```sh
cd src/packages/launchpad/sea
./build-sea.sh
```

The builder invokes `npx -y postject` and uses `codesign` on macOS. It writes a
platform-specific archive under `src/packages/launchpad/build/sea/`.

The executable embeds Node and the application payload, but it is not free of
system dependencies: first extraction invokes `tar -Jxf`, so the target needs
`tar` with xz support. Native addons and the embedded Node runtime must also
match the target OS, architecture, and runtime libraries. These build scripts
do not establish a minimum supported Ubuntu or macOS release; validate the
result on each intended target before distributing it.
