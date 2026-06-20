FROM ubuntu:24.04

ENV container=docker
ENV DEBIAN_FRONTEND=noninteractive

STOPSIGNAL SIGRTMIN+3

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
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
    libpq-dev \
    openssh-server \
    openssl \
    passt \
    podman \
    postgresql \
    postgresql-client \
    procps \
    python3 \
    rsync \
    slirp4netns \
    sudo \
    systemd \
    systemd-sysv \
    uidmap \
    xz-utils \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN systemctl mask \
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
COPY cocalc-star-docker-preflight.sh /usr/local/sbin/cocalc-star-docker-preflight
COPY cocalc-star-docker-init.sh /usr/local/sbin/cocalc-star-docker-init
COPY cocalc-star-docker-init.service /etc/systemd/system/cocalc-star-docker-init.service

RUN chmod 0755 \
    /usr/local/sbin/cocalc-star-docker-preflight \
    /usr/local/sbin/cocalc-star-docker-init \
  && mkdir -p /var/lib/cocalc /opt/cocalc-star /mnt/cocalc /run/systemd \
  && systemctl enable cocalc-star-docker-init.service

VOLUME ["/var/lib/cocalc"]

EXPOSE 80 9100

CMD ["/sbin/init"]
