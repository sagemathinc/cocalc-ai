# CoCalc Star Docker Preview

This is a privileged Docker-based preview appliance for CoCalc Star. It is for
local evaluation and release validation, not for hardened multi-tenant
production hosting.

The Docker layer is intentionally a thin packaging wrapper. The first preview
boots the current single-hub Star runtime, but the customer-facing workflow
should not depend on that internal layout. Keep this wrapper replaceable by the
Rocket/bay-style multi-worker systemd runtime as Star moves toward the same
scalable process layout used by full Rocket deployments.

In particular, avoid making image tags, volumes, environment variables, or docs
promise "one hub process" semantics. The intended transition path is that a
customer can keep using the same Docker preview shape while the container
internals evolve from the current compact Star deployment to multiple Node.js
processes and service units.

Build the image from a CoCalc source checkout:

```sh
src/scripts/star/docker-preview/build-image.sh --tag cocalc/star:preview
```

Run it on a Linux Docker host with systemd and cgroup v2:

```sh
docker run --privileged --cgroupns=host \
  --security-opt seccomp=unconfined \
  --tmpfs /run --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v cocalc-star-data:/var/lib/cocalc \
  -p 8170:80 \
  cocalc/star:preview
```

Open `http://localhost:8170` after the first-boot installer prints the
bootstrap URL. The persistent data volume is `/var/lib/cocalc`; it contains the
Star database, project data image, rootfs cache, secrets, and bootstrap state.

Useful commands:

```sh
docker exec -it <container> /opt/cocalc-star/source/src/scripts/star/star.sh status
docker exec -it <container> /opt/cocalc-star/source/src/scripts/star/star.sh doctor
docker exec -it <container> /opt/cocalc-star/source/src/scripts/star/star.sh smoke
docker exec -it <container> /opt/cocalc-star/source/src/scripts/star/star.sh bootstrap-link
```

Runtime environment knobs:

```sh
COCALC_STAR_HOSTNAME=localhost
COCALC_STAR_HTTP_PORT=8170
COCALC_STAR_ACCESS_URL=http://localhost:8170
COCALC_STAR_DOCKER_ALLOW_DEGRADED=1
COCALC_STAR_BTRFS_SIZE=40G
COCALC_STAR_BUILD_DEFAULT_ROOTFS=1
COCALC_STAR_DEFAULT_ROOTFS_BASE_IMAGE=docker.io/buildpack-deps:26.04
```

Stop and restart with the same volume to preserve state:

```sh
docker stop <container>
docker run ... -v cocalc-star-data:/var/lib/cocalc cocalc/star:preview
```

Remove all preview data only after exporting anything you need:

```sh
docker volume rm cocalc-star-data
```
