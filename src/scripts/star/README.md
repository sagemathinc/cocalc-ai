# CoCalc Star Installer

CoCalc Star is a single-VM CoCalc deployment. It installs a local Launchpad
control plane, local Postgres, a local project host, rootless Podman project
execution, and a default Jupyter/LaTeX rootfs on a dedicated Ubuntu VM.

## Build A Release Artifact

From a CoCalc source checkout:

```sh
src/scripts/star/build-star-release.sh /tmp/cocalc-star-20260531T000000Z.tar.gz
```

The default release is a small source artifact. It is useful for proving the
installer path, but the target VM must run the full pnpm/build sequence.

For normal Star upgrade testing, build a runtime artifact instead:

```sh
STAR_RELEASE_MODE=runtime \
  src/scripts/star/build-star-release.sh /tmp/cocalc-star-runtime-20260531T000000Z.tar.gz
```

Runtime artifacts include the built workspace, `node_modules`, the project
bundle, backend tools, and frontend assets. They are larger than source
artifacts, but installs and upgrades skip the target-VM source build.

Copy the release artifact to a fresh Ubuntu 24.04 VM.

## Install On A Fresh VM

The release artifact contains an installer wrapper and either a source or
runtime tarball. The normal operator install path is:

```sh
tar -xzf cocalc-star-<release>.tar.gz
cd cocalc-star-<release>
sudo STAR_ASSUME_YES=1 ./install.sh
```

For a curl-style install, publish both the release artifact and the matching
`install-release.sh`, then run:

```sh
curl -fsSL https://example.com/install-release.sh \
  | sudo STAR_ASSUME_YES=1 bash -s -- https://example.com/cocalc-star-<release>.tar.gz
```

For the public GitHub release path, publish:

- `install-cocalc-star.sh`
- `cocalc-star-runtime-linux-x64.tar.gz`
- optionally `cocalc-star-runtime-linux-arm64.tar.gz`

Build those assets with:

```sh
src/scripts/star/build-github-release-assets.sh dist/star/github
```

Then the intended copy/paste installer is:

```sh
curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh \
  | sudo STAR_ASSUME_YES=1 bash
```

The installer auto-detects `x86_64` vs `aarch64` and downloads the matching
`cocalc-star-runtime-linux-<arch>.tar.gz` asset from the latest GitHub release.
Set `COCALC_STAR_RELEASE_URL` to test a specific artifact URL.

By default this installs source under a versioned release directory and points
`/opt/cocalc-star/source` at the active release. It uses the sudo caller as the
Star runtime user and starts CoCalc on `http://127.0.0.1:9100`.

## Validate

After install:

```sh
sudo /opt/cocalc-star/source/src/scripts/star/star.sh doctor
sudo /opt/cocalc-star/source/src/scripts/star/star.sh smoke
sudo /opt/cocalc-star/source/src/scripts/star/star.sh bootstrap-link
```

The GCP proof-of-concept harness can validate install, smoke, release upgrade,
rollback, and hard-reset durability in one run:

```sh
RUN_UPGRADE_ROLLBACK_TEST=1 RUN_RESET_TEST=1 src/scripts/star-poc/gcp-create-star-poc.sh
```

For browser access from your laptop, port-forward to the VM:

```sh
ssh -L 7001:127.0.0.1:9100 user@vm
```

Then open `http://127.0.0.1:7001` and use the bootstrap link to create the
first admin account.

## Useful Overrides

```sh
STAR_INSTALL_ROOT=/opt/cocalc-star
STAR_USER=cocalc-star
STAR_PROJECT_HOST_REGION=wnam
STAR_BTRFS_SIZE=100G
STAR_BUILD=1
STAR_BUILD_DEFAULT_ROOTFS=1
STAR_DEFAULT_ROOTFS_BASE_IMAGE=docker.io/buildpack-deps:26.04
```

## Releases And Rollback

Each tarball install creates:

```text
/opt/cocalc-star/releases/<release-id>/source
/opt/cocalc-star/releases/<release-id>/release.json
/opt/cocalc-star/source -> releases/<release-id>/source
/opt/cocalc-star/current -> releases/<release-id>
```

Useful commands:

```sh
sudo /opt/cocalc-star/source/src/scripts/star/star.sh current-release
sudo /opt/cocalc-star/source/src/scripts/star/star.sh releases
sudo /opt/cocalc-star/source/src/scripts/star/star.sh upgrade /path/to/cocalc-star-<release>.tar.gz
sudo /opt/cocalc-star/source/src/scripts/star/star.sh rollback [release-id]
```

Use a dedicated VM. The installer changes system packages, systemd services,
sudoers, mounts, and local runtime data.

## Artifact Contents

Each release artifact contains:

```text
cocalc-star-<release>/
  install.sh
  install-release.sh
  cocalc-star-src.tar.gz or cocalc-star-runtime.tar.gz
  release.json
  SHA256SUMS
```

`install.sh` verifies the checksums when `sha256sum` is available, extracts the
versioned installer from the payload tarball, and then delegates to
`src/scripts/star/install-from-tarball.sh`. Runtime payloads set `STAR_BUILD=0`
before delegation, so the same mutation logic is reused without rebuilding
CoCalc on the target VM.

`install-release.sh` is the curl/bootstrap wrapper. It accepts either a local
artifact path or an HTTP(S) URL, extracts the release, and invokes the same
`install.sh` path used above.
