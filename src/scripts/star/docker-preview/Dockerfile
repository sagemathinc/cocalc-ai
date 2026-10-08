FROM ubuntu:24.04

ARG COCALC_STAR_RELEASE_ID=unknown
ARG COCALC_STAR_GIT_REVISION=unknown
ARG COCALC_STAR_TARGETARCH=unknown

LABEL org.opencontainers.image.title="CoCalc Star"
LABEL org.opencontainers.image.description="Self-hosted CoCalc Star appliance"
LABEL org.opencontainers.image.source="https://github.com/sagemathinc/cocalc-ai"
LABEL org.opencontainers.image.version="${COCALC_STAR_RELEASE_ID}"
LABEL org.opencontainers.image.revision="${COCALC_STAR_GIT_REVISION}"
LABEL com.cocalc.star.platform="linux/${COCALC_STAR_TARGETARCH}"

ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive

STOPSIGNAL SIGRTMIN+3

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    apparmor \
    bash \
    btrfs-progs \
    build-essential \
    ca-certificates \
    caddy \
    catatonit \
    curl \
    dbus \
    dbus-user-session \
    fuse-overlayfs \
    git \
    iproute2 \
    iptables \
    jq \
    libatomic1 \
    libcap2-bin \
    libpq-dev \
    nftables \
    openssh-server \
    openssl \
    passt \
    podman \
    postgresql \
    postgresql-client \
    procps \
    python3 \
    ripgrep \
    rsync \
    slirp4netns \
    sudo \
    systemd \
    systemd-sysv \
    uidmap \
    xz-utils \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# The Star runtime user owns data in the /var/lib/cocalc volume, so its ids
# must not depend on which users a future base image happens to create.
RUN groupadd --gid 1001 cocalc-star \
  && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash cocalc-star

# Node.js for the Star services, installed the same way the Star installer
# does, so first boot and upgrades need no download.
USER cocalc-star
RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
  && bash -c 'source "$HOME/.nvm/nvm.sh" && nvm install 26 && nvm alias default 26 && nvm cache clear'
USER root

# apparmor.service and nftables.service would load or flush host-global
# kernel policy; Star manages the pieces it needs itself.
RUN systemctl mask \
    apparmor.service \
    nftables.service \
    dev-hugepages.mount \
    sys-fs-fuse-connections.mount \
    systemd-remount-fs.service \
    systemd-update-utmp.service \
    systemd-networkd-wait-online.service \
    apt-daily.service \
    apt-daily.timer \
    apt-daily-upgrade.service \
    apt-daily-upgrade.timer \
  || true

COPY cocalc-star-release.tar.gz /usr/local/share/cocalc-star-docker/cocalc-star-release.tar.gz
COPY cocalc-star-rootfs-cache.tar.gz /usr/local/share/cocalc-star-docker/cocalc-star-rootfs-cache.tar.gz
COPY cocalc-star-docker-preflight.sh /usr/local/sbin/cocalc-star-docker-preflight
COPY cocalc-star-docker-init.sh /usr/local/sbin/cocalc-star-docker-init
COPY cocalc-star-docker-entrypoint.sh /usr/local/sbin/cocalc-star-docker-entrypoint
COPY cocalc-star-docker-init.service /etc/systemd/system/cocalc-star-docker-init.service
COPY cocalc-star-podman.apparmor /etc/apparmor.d/cocalc-star-podman

RUN chmod 0755 \
    /usr/local/sbin/cocalc-star-docker-preflight \
    /usr/local/sbin/cocalc-star-docker-init \
    /usr/local/sbin/cocalc-star-docker-entrypoint \
  && printf '%s\n' "${COCALC_STAR_RELEASE_ID}" >/usr/local/share/cocalc-star-docker/release-id \
  && ln -s /opt/cocalc-star/source/src/scripts/star/star.sh /usr/local/bin/star \
  && mkdir -p /var/lib/cocalc /opt/cocalc-star /mnt/cocalc /run/systemd \
  && systemctl enable cocalc-star-docker-init.service

VOLUME ["/var/lib/cocalc"]

EXPOSE 80 443

CMD ["/usr/local/sbin/cocalc-star-docker-entrypoint"]
