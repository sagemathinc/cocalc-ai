# Project container seccomp profile

- `base-seccomp.json`: the hosts' `/usr/share/containers/seccomp.json` from
  Ubuntu's `golang-github-containers-common` 0.57.4+ds1-2ubuntu0.2 (sha256
  `cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c`),
  unmodified. It comes from containers/common, Apache License 2.0. The
  bundled podman reads this file when no profile is given, so it is what
  project containers ran with until now.
- `generate.py`: derives `cocalc-project-seccomp.json` from it. The
  docstring lists every change and why the rules look the way they do. It
  refuses a base whose socket rules differ from the reviewed ones.
- `cocalc-project-seccomp.json`: the generated profile, passed to
  `podman create` by `../project-seccomp.ts`. Don't edit it; regenerate:

      python3 -I generate.py base-seccomp.json cocalc-project-seccomp.json

- `generate.test.py`: unit tests (`python3 -I generate.test.py`).
- `kernel_check.test.py`: tests for its architecture selection
  (`python3 -I kernel_check.test.py`).
- `kernel_check.py`: a by-hand check on a Linux host that loads the profile
  through libseccomp as crun does, issues real syscalls, and compares it
  with the base over an argument grid. See its docstring.
