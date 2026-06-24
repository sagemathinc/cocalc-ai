set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

run_noninteractive() {
  if [ -n "$SUDO" ]; then
    $SUDO env DEBIAN_FRONTEND=noninteractive "$@"
  else
    DEBIAN_FRONTEND=noninteractive "$@"
  fi
}

owner_uid="${OWNER_UID:-2001}"
owner_gid="${OWNER_GID:-2001}"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \
  asymptote \
  biber \
  ca-certificates \
  chktex \
  cm-super \
  context \
  curl \
  dvisvgm \
  fonts-dejavu \
  fonts-freefont-otf \
  fonts-liberation \
  fonts-linuxlibertine \
  fonts-noto \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  ghostscript \
  git \
  graphviz \
  inkscape \
  latexmk \
  lmodern \
  make \
  pandoc \
  poppler-utils \
  psutils \
  python3 \
  python3-pygments \
  qpdf \
  texlive-base \
  texlive-bibtex-extra \
  texlive-binaries \
  texlive-extra-utils \
  texlive-font-utils \
  texlive-fonts-extra \
  texlive-fonts-recommended \
  texlive-formats-extra \
  texlive-games \
  texlive-humanities \
  texlive-lang-all \
  texlive-latex-base \
  texlive-latex-extra \
  texlive-latex-recommended \
  texlive-luatex \
  texlive-metapost \
  texlive-music \
  texlive-pictures \
  texlive-plain-generic \
  texlive-pstricks \
  texlive-publishers \
  texlive-science \
  texlive-xetex

$SUDO mktexlsr
$SUDO updmap-sys --syncwithtrees || true
$SUDO fmtutil-sys --all || true

if [ -d /usr/local/share/texmf ]; then
  $SUDO chown -R "$owner_uid:$owner_gid" /usr/local/share/texmf || true
fi

$SUDO rm -rf /var/lib/apt/lists/*
