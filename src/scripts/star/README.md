# CoCalc Star Installer

CoCalc Star is a single-VM CoCalc deployment. It installs a local Launchpad
control plane, local Postgres, a local project host, rootless Podman project
execution, and a default Jupyter/LaTeX rootfs on a dedicated Ubuntu VM.

## Build A Tarball

From a CoCalc source checkout:

```sh
src/scripts/star/build-star-tarball.sh /tmp/cocalc-star-src.tar.gz
```

Copy `/tmp/cocalc-star-src.tar.gz` to a fresh Ubuntu 24.04 VM.

## Install On A Fresh VM

The installer is inside the tarball. Extract only that script first, then run
it against the full tarball:

```sh
mkdir -p /tmp/cocalc-star-installer
tar -xzf /tmp/cocalc-star-src.tar.gz -C /tmp/cocalc-star-installer \
  src/scripts/star/install-from-tarball.sh
sudo STAR_ASSUME_YES=1 \
  /tmp/cocalc-star-installer/src/scripts/star/install-from-tarball.sh \
  /tmp/cocalc-star-src.tar.gz
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
