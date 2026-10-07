# CoCalc Star in Docker

CoCalc Star is a complete single-server CoCalc. The Docker image is the
easiest way to install and upgrade it: everything runs in one container, and
all of your data lives in one Docker volume.

Docker is used here only to distribute the software. The container runs
privileged; the isolation boundary between users is inside the container,
where each project runs in its own rootless Podman container.

## Requirements

- A Linux host with Docker and cgroup v2 (any current distribution).
- 4 or more CPUs, 16 GB of RAM, and 50 GB or more of free disk space for the
  volume (projects are stored in a 40 GB sparse btrfs image by default).
- For a public server: a DNS name pointing at the host and inbound TCP port 443
  open. Port 80 is optional.

## Install

On a server with a DNS name (HTTPS certificates are obtained automatically):

```sh
docker run -d --name cocalc-star --restart unless-stopped \
  --privileged --cgroupns=host \
  -v cocalc-star:/var/lib/cocalc \
  -p 443:443 -p 80:80 \
  -e COCALC_STAR_DOMAIN=star.example.com \
  sagemathinc/star
```

To try it on your own computer instead, omit the domain and open
<http://localhost:8170>:

```sh
docker run -d --name cocalc-star --restart unless-stopped \
  --privileged --cgroupns=host \
  -v cocalc-star:/var/lib/cocalc \
  -p 8170:80 -e COCALC_STAR_HTTP_PORT=8170 \
  sagemathinc/star
```

First boot takes a few minutes. Follow it and get the link for creating the
first admin account with:

```sh
docker logs -f cocalc-star
```

The link is printed again at any time by:

```sh
docker exec cocalc-star /opt/cocalc-star/source/src/scripts/star/star.sh bootstrap-link
```

## Upgrade

Pull the new image and replace the container. The volume keeps all accounts,
projects, settings and certificates:

```sh
docker pull sagemathinc/star
docker rm -f cocalc-star
docker run -d --name cocalc-star ...   # the same command you installed with
```

On start, the container detects the new release, reinstalls it over the
existing volume and logs `upgrading CoCalc Star from <old> to <new>`. Running
projects are stopped by the upgrade; users can start them again immediately.

To roll back, run the previous image tag with the same volume.

## Back up

Everything is in the `cocalc-star` volume. Stop the container for a
consistent copy:

```sh
docker stop cocalc-star
docker run --rm -v cocalc-star:/data -v "$PWD":/backup ubuntu \
  tar -C /data -czf /backup/cocalc-star-backup.tar.gz .
docker start cocalc-star
```

## Settings

| Variable                 | Default     | Meaning                                                             |
| ------------------------ | ----------- | ------------------------------------------------------------------- |
| `COCALC_STAR_DOMAIN`     |             | Public DNS name; enables HTTPS with automatic certificates.         |
| `COCALC_STAR_ACME_EMAIL` |             | Contact email for the certificate authority.                        |
| `COCALC_STAR_HOSTNAME`   | `localhost` | Host name used in links when no domain is set.                      |
| `COCALC_STAR_HTTP_PORT`  | `80`        | Host port mapped to the container's port 80, used in printed links. |
| `COCALC_STAR_ACCESS_URL` |             | Override the URL printed in links entirely.                         |
| `COCALC_STAR_BTRFS_SIZE` | `40G`       | Size of the project storage image, set on first boot.               |

## Troubleshooting

```sh
docker exec cocalc-star /opt/cocalc-star/source/src/scripts/star/star.sh status
docker exec cocalc-star /opt/cocalc-star/source/src/scripts/star/star.sh doctor
docker exec cocalc-star /opt/cocalc-star/source/src/scripts/star/star.sh smoke
docker exec cocalc-star journalctl -u cocalc-star-hub -n 200
```

On hosts that restrict unprivileged user namespaces with AppArmor (Ubuntu
23.10 and later), the container loads a profile named `cocalc-star-podman`
into the host kernel that gives Star's managed Podman the same permission the
distribution grants `/usr/bin/podman`.

## Building the image

The Docker layer is intentionally a thin packaging wrapper around the normal
Star release artifact, so the container internals can evolve (for example to
the multi-process Rocket/bay layout) without changing the volume, ports or
environment variables documented above.

Build an image from a CoCalc source checkout on a Linux host with Docker,
Node.js 26 (via nvm) and pnpm 11:

```sh
src/scripts/star/docker-preview/build-image.sh --tag cocalc/star:dev
```

This builds the runtime release artifact, then runs a builder container that
precomputes the default RootFS cache and embeds it in the image, so first boot
only initializes local state. Useful options:

- `--rootfs-cache <tgz>` reuses a RootFS cache artifact from an earlier build.
- `--skip-runtime-build` packages the already-built workspace.
- `--skip-rootfs-cache` builds the RootFS on first boot instead (slow; for
  development only).

Set `COCALC_STAR_CONTAINER_RUNTIME_TARBALL` to reuse a managed Podman runtime
archive and skip compiling it.

## Native multi-architecture Docker Hub releases

Published Star images are built natively. This avoids QEMU during the expensive
Star and RootFS builds and guarantees that each image contains the matching
Linux project-tools bundle.

The release workflow uses three immutable tags:

```text
sagemathinc/star:<release-id>-amd64
sagemathinc/star:<release-id>-arm64
sagemathinc/star:<release-id>
```

The first two are ordinary native images. The third is an OCI image index that
selects the correct native image for `linux/amd64` or `linux/arm64`.

Log in to Docker Hub on each build machine:

```sh
docker login
```

On the x86_64 Linux builder, build and push the x86 child from the matching
runtime release artifact:

```sh
RELEASE_ID=20260729T191811Z-fe6287a6bc3a
src/scripts/star/docker-preview/multiarch.sh build \
  --release-artifact \
    "dist/star/github-${RELEASE_ID}/cocalc-star-runtime-linux-x64.tar.gz" \
  --push
```

On an Apple Silicon Mac, first check out the same Git revision and build the
arm64 runtime artifact with the same release ID:

```sh
RELEASE_ID=20260729T191811Z-fe6287a6bc3a
git checkout fe6287a6bc3a
COCALC_STAR_RELEASE_ARCH=arm64 STAR_RELEASE_ID="$RELEASE_ID" \
  src/scripts/star/build-github-release-assets.sh \
  "dist/star/github-${RELEASE_ID}-arm64"
```

Then run the publishing script from a checkout that contains it, passing the
arm64 artifact by absolute path:

```sh
src/scripts/star/docker-preview/multiarch.sh build \
  --release-artifact \
    "/path/to/dist/star/github-${RELEASE_ID}-arm64/cocalc-star-runtime-linux-arm64.tar.gz" \
  --push
```

The publisher verifies the clean release metadata, embedded project-tools
architecture, Docker engine architecture, resulting image platform, release
label, and Git revision label before it pushes a child tag.

After both child tags exist, publish and verify the release index from either
machine:

```sh
src/scripts/star/docker-preview/multiarch.sh index \
  --release-id "$RELEASE_ID"
src/scripts/star/docker-preview/multiarch.sh inspect \
  --release-id "$RELEASE_ID"
```

Test the immutable release tag directly:

```sh
docker pull "sagemathinc/star:${RELEASE_ID}"
docker image inspect "sagemathinc/star:${RELEASE_ID}" \
  --format '{{.Os}}/{{.Architecture}}'
```

None of the commands above modifies `latest`. Only after both platforms have
been tested, promote the verified release index explicitly:

```sh
src/scripts/star/docker-preview/multiarch.sh promote \
  --release-id "$RELEASE_ID" \
  --yes
```
