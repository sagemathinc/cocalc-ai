# RootFS Rustic Same-Host Publish Sweep

Measured on March 28, 2026 against host
`18521f3d-1d43-4663-aec3-91fc7374d114` (`rootfs-test-2`) with four real
projects on the same host:

- `lean-image`
- `apt-jupyter`
- `conda2`
- `conda14-local-smoke`

Raw results:

- per-host `1`: `572.11s`, all `4/4` succeeded
- per-host `2`: `256.83s`, all `4/4` succeeded
- per-host `3`: `173.84s`, only `2/4` succeeded
- per-host `4`: `235.53s`, only `3/4` succeeded

Important conclusion:

- `2` is the highest clean setting measured on the current small host
- `3` and `4` are not currently safe because they trigger btrfs qgroup errors
  during snapshot staging:
  - `ERROR: quota rescan failed: Operation now in progress`

Interpretation:

- moving the per-host RootFS publish cap from `1` to `2` looks justified on the
  current 4-vCPU test host
- moving beyond `2` should wait until the qgroup concurrency issue is fixed or
  explicitly designed around

Related raw data:

- [rootfs-rustic-same-host-publish-sweep-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/rootfs-benchmarks/rootfs-rustic-same-host-publish-sweep-2026-03-27.json)
