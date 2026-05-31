# CoCalc Star Installer

CoCalc Star is a single-VM CoCalc deployment. It installs a local Launchpad
control plane, local Postgres, a local project host, rootless Podman project
execution, and a default Jupyter/LaTeX rootfs on a dedicated Ubuntu VM.

## Build A Release Artifact

From a CoCalc source checkout:

```sh
src/scripts/star/build-star-release.sh /tmp/cocalc-star-20260531T000000Z.tar.gz
```

Copy the release artifact to a fresh Ubuntu 24.04 VM.

## Install On A Fresh VM

The release artifact contains an installer wrapper and the source tarball. The
normal operator install path is:

```sh
tar -xzf cocalc-star-<release>.tar.gz
cd cocalc-star-<release>
sudo STAR_ASSUME_YES=1 ./install.sh
```

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
STAR_USER=user
STAR_BTRFS_SIZE=100G
STAR_BUILD=1
STAR_BUILD_DEFAULT_ROOTFS=1
STAR_DEFAULT_ROOTFS_BASE_IMAGE=ubuntu:24.04
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
sudo /opt/cocalc-star/source/src/scripts/star/star.sh rollback [release-id]
```

Use a dedicated VM. The installer changes system packages, systemd services,
sudoers, mounts, and local runtime data.

## Artifact Contents

Each release artifact contains:

```text
cocalc-star-<release>/
  install.sh
  cocalc-star-src.tar.gz
  release.json
  SHA256SUMS
```

`install.sh` verifies the checksums when `sha256sum` is available, extracts the
versioned installer from `cocalc-star-src.tar.gz`, and then delegates to
`src/scripts/star/install-from-tarball.sh`. This keeps the mutation logic in one
installer path while giving users a simple release artifact.
