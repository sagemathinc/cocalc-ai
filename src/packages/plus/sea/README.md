# CoCalc Plus Single Executable Build

This packages a self-extracting CoCalc Plus executable using
[Node.js single executable applications](https://nodejs.org/api/single-executable-applications.html).

Use the repository's normal build prerequisites and installed workspace
dependencies. The SEA builder requires Node.js 26 and supports Linux and macOS
in `build-sea.sh`. Put Node.js 26 on `PATH`; `COCALC_SEA_NODE_BIN` can select the
Node binary used for injection. A Node version manager is optional.

From the repository root, build the payload and executable with:

```sh
pnpm --dir src/packages/plus sea
```

If `src/packages/plus/build/bundle.tar.xz` has already been built, run just
the SEA step from its own directory:

```sh
cd src/packages/plus/sea
./build-sea.sh
```

The builder invokes `npx -y postject` and uses `codesign` on macOS. It writes a
platform-specific archive under `src/packages/plus/build/sea/`.
Plus also leaves the unpacked executable and a `cocalc-plus` symlink there.

The executable embeds Node and the application payload, but it is not free of
system dependencies: first extraction invokes `tar -Jxf`, so the target needs
`tar` with xz support. Native addons and the embedded Node runtime must also
match the target OS, architecture, and runtime libraries. These build scripts
do not establish a minimum supported Ubuntu or macOS release; validate the
result on each intended target before distributing it.

## Historical Remote-Host Experiment

The following notes preserve an earlier forwarding experiment, including an
unresolved proxy attempt. They are not a current installation procedure.

Using this on a remote host.

scp it to root@[server]

Start it

Setup port forward to your laptop (e.g., using reflect-sync):

```sh
wstein@lite:~/build/sea/cocalc$ reflect forward create -n wdev 9000 root@35.212.230.72:42513
Created session fwrd_R1STMVOKmnS2Q3W4ic0YP5slUOBpWvyJq96KQgYXMfw
wstein@lite:~/build/sea/cocalc$
```

This should work for proxy.json to directly connect, but it isn't:

```
[
  {"path":"/","target":"http://localhost:42513"}
]
```

but we should just add ssl support and use this instead of that proxy.

### Proxy Prefixes (Current Behavior)

When running `cocalc-plus` behind a reverse proxy, use a strip-prefix setup.
The upstream should receive requests as if Plus is mounted at `/`.

- Supported: external `/some/prefix/...` -> upstream `/...`
- Not required: compile-time `BASE_PATH`
- Not the same thing: `/port/...` routing (that is separate and mainly for app proxies like JupyterLab)
