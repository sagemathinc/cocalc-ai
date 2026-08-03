set -Eeuo pipefail

# Merge stderr into stdout. The build log is a single stream, and stdout is
# block-buffered when piped while stderr is not, so keeping them separate
# reorders failure messages away from the step they belong to.
exec 2>&1

# Report which command failed; a bare command aborting under `set -e`
# otherwise produces no output at all.
trap 'echo "install: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

# Install or update a full upstream TeX Live tree under /usr/local.
#
# The tree lives at /usr/local/texlive/<year> and the installer symlinks every
# binary into /usr/local/bin, so tex/latex/tlmgr are on PATH for login shells
# and for non-login subprocesses (which is what CoCalc's LaTeX editor uses).
#
# mode=install builds the tree from scratch with install-tl.
# mode=update runs tlmgr update within an already installed release. tlmgr
# never moves between yearly releases; a new year is always a fresh install.

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

mode="${MODE:-install}"
year="${YEAR:-2026}"
scheme="${SCHEME:-scheme-full}"
mirror="${MIRROR:-https://mirror.ctan.org/systems/texlive/tlnet}"
paper="${PAPER:-letter}"
docfiles="${DOCFILES:-false}"
srcfiles="${SRCFILES:-false}"
autobackup="${AUTOBACKUP:-false}"
fontconfig="${FONTCONFIG:-true}"
disable_apt_texlive="${DISABLE_APT_TEXLIVE:-true}"
purge_apt_texlive="${PURGE_APT_TEXLIVE:-true}"
required_tl_packages="${REQUIRED_TL_PACKAGES:-texcount pythontex latexmk biber}"
luaotfload_db="${LUAOTFLOAD_DB:-true}"
min_free_kb="${MIN_FREE_KB:-9000000}"

case "$mode" in
  install|update) ;;
  *) echo "unsupported mode: $mode (expected install or update)" >&2; exit 1 ;;
esac

# TeX Live ships one binary directory per platform under bin/<platform>. The
# install profile needs a matching binary_<platform> line, and update mode uses
# it to address the intended tree's tlmgr directly.
case "$(uname -m)" in
  x86_64)        tlplatform="x86_64-linux"  ;;
  aarch64|arm64) tlplatform="aarch64-linux" ;;
  *) echo "unsupported architecture for TeX Live: $(uname -m)" >&2; exit 1 ;;
esac

texdir="/usr/local/texlive/$year"
bindir="$texdir/bin/$tlplatform"
tlmgr="$bindir/tlmgr"

bool01() {
  case "$1" in
    true|True|TRUE|1|yes) echo 1 ;;
    *) echo 0 ;;
  esac
}

# --------------------------------------------------------------------------
# APT shim: a control-only dummy package that Provides the Debian texlive-*
# names, so pulling in an unrelated package does not drag Debian's TeX Live
# along as a dependency. Built with dpkg-deb from the base system; pulls in no
# extra packages and needs no network.
#
# What this does and does not guarantee:
#
#   - it satisfies other packages' Depends on the listed names, which is how
#     Debian TeX Live normally sneaks back in,
#   - the Provides are versioned, so a versioned dependency such as
#     `texlive-latex-base (>= 2024)` is satisfied too; unversioned Provides
#     would not be,
#   - it does NOT stop an explicit `apt-get install texlive-latex-base`, which
#     still selects Debian's real package. Conflicts/Replaces would block that
#     but would also make the shim uninstallable alongside anything that
#     legitimately wants those packages, which is a worse trade for a project
#     image users are free to modify.
# --------------------------------------------------------------------------
TEXLIVE_SHIM_PROVIDES="
texlive texlive-full texlive-base texlive-binaries texlive-common
texlive-latex-base texlive-latex-base-doc texlive-latex-recommended
texlive-latex-recommended-doc texlive-latex-extra texlive-latex-extra-doc
texlive-plain-generic texlive-xetex texlive-luatex texlive-pictures
texlive-pictures-doc texlive-pstricks texlive-pstricks-doc texlive-science
texlive-science-doc texlive-metapost texlive-metapost-doc
texlive-bibtex-extra texlive-extra-utils texlive-font-utils
texlive-fonts-recommended texlive-fonts-recommended-doc texlive-fonts-extra
texlive-fonts-extra-doc texlive-fonts-extra-links texlive-formats-extra
texlive-games texlive-humanities texlive-humanities-doc texlive-music
texlive-publishers texlive-publishers-doc texlive-lang-arabic
texlive-lang-chinese texlive-lang-cjk texlive-lang-cyrillic
texlive-lang-czechslovak texlive-lang-english texlive-lang-european
texlive-lang-french texlive-lang-german texlive-lang-greek
texlive-lang-italian texlive-lang-japanese texlive-lang-korean
texlive-lang-other texlive-lang-polish texlive-lang-portuguese
texlive-lang-spanish latexmk biber context asymptote chktex lacheck lmodern
tex-gyre dvidvi dvipng dvisvgm ps2eps psutils t1utils tex4ht texinfo
lcdf-typetools latexdiff purifyeps feynmf fragmaster cm-super
cm-super-minimal preview-latex-style
"

install_apt_shim() {
  command -v dpkg-deb >/dev/null || {
    echo "dpkg-deb not found; skipping APT shim" >&2
    return 0
  }
  local pkgdir deb shim_version provides name
  pkgdir="$(mktemp -d)"
  deb="${pkgdir}.deb"
  shim_version="${year}.99999999-1"

  # Versioned provides: `name (= version)` satisfies both unversioned and
  # versioned dependencies, where a bare `name` satisfies only the former.
  provides=""
  for name in $TEXLIVE_SHIM_PROVIDES; do
    provides="${provides:+$provides, }$name (= $shim_version)"
  done

  mkdir -p "$pkgdir/DEBIAN"
  cat > "$pkgdir/DEBIAN/control" <<TEXLIVE_LOCAL_CONTROL
Package: texlive-local
Version: ${shim_version}
Architecture: all
Maintainer: CoCalc <office@sagemath.com>
Section: misc
Priority: optional
Provides: ${provides}
Description: Dummy package for the local upstream TeX Live install
 Prevents APT from pulling in the Debian/Ubuntu TeX Live packages as
 dependencies, because a full TeX Live tree is already installed under
 /usr/local/texlive/${year}.
TEXLIVE_LOCAL_CONTROL
  dpkg-deb --build --root-owner-group "$pkgdir" "$deb"
  # dpkg -i replaces an already-installed texlive-local in place. Purging it
  # first would open a window in which nothing provides the texlive-* names,
  # and any package depending on them would become removable.
  $SUDO dpkg -i "$deb"
  rm -rf "$pkgdir" "$deb"
  echo ">> texlive-local installed; APT treats TeX Live as satisfied"
}

# --------------------------------------------------------------------------
# Ensure the TeX Live packages CoCalc's editors depend on are actually present.
#
# scheme-full happens to include all of these, so today this is a no-op. That
# incidental coverage is the reason to state the requirement explicitly: a
# narrower `scheme` input, or an upstream reshuffle of which collection owns a
# package, would otherwise remove a feature silently. texcount in particular
# backs the word count frame and is absent from smaller schemes.
#
# `tlmgr info --only-installed` exits non-zero for a package that is not
# installed locally, which makes it a reliable probe.
# --------------------------------------------------------------------------
ensure_tl_packages() {
  [ -n "$required_tl_packages" ] || return 0
  local missing="" pkg
  for pkg in $required_tl_packages; do
    if ! "$tlmgr" info --only-installed --data name "$pkg" >/dev/null 2>&1; then
      missing="$missing $pkg"
    fi
  done
  if [ -z "$missing" ]; then
    echo ">> required TeX Live packages present: $required_tl_packages"
    return 0
  fi
  echo ">> installing missing TeX Live packages:$missing"
  # shellcheck disable=SC2086
  $SUDO "$tlmgr" install $missing
}

# --------------------------------------------------------------------------
# Ensure the handful of non-TeX tools this module and its verification need.
#
# Runs in both modes, and only touches apt when something is actually missing:
# an image built before this module existed has no poppler-utils, so an update
# build would otherwise fail verification on a tree that is perfectly fine.
#
# Package lists are refreshed only when there is something to install, and are
# dropped again afterwards. Base images ship with an empty /var/lib/apt/lists
# and repopulating it would add tens of MB to every published release.
# --------------------------------------------------------------------------
ensure_runtime_deps() {
  local missing=""
  command -v perl >/dev/null || missing="$missing perl"
  command -v curl >/dev/null || missing="$missing curl"
  command -v fc-cache >/dev/null || missing="$missing fontconfig"
  command -v gs >/dev/null || missing="$missing ghostscript"
  # pdftotext is what makes the document tests assert on content rather than
  # mere file existence, so it is a hard requirement, not a nicety.
  command -v pdftotext >/dev/null || missing="$missing poppler-utils"
  [ -e /etc/ssl/certs/ca-certificates.crt ] || missing="$missing ca-certificates"

  if [ -z "$missing" ]; then
    echo ">> runtime prerequisites already present"
    return 0
  fi

  echo ">> installing missing runtime prerequisites:$missing"
  $SUDO apt-get update
  # shellcheck disable=SC2086
  run_noninteractive apt-get install -y --no-install-recommends $missing
  # Drop both the repository metadata and the downloaded archives; either would
  # otherwise be captured in the published image.
  $SUDO apt-get clean
  $SUDO rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
}

# --------------------------------------------------------------------------
# Remove Debian's own TeX Live packages. They are several GB, and their
# binaries in /usr/bin shadow nothing today but would compete with the
# upstream tree's symlinks in /usr/local/bin on any PATH reordering.
#
# This runs *after* the shim is installed, not before: with texlive-local
# already providing the texlive-* names, packages that depend on them stay
# satisfied and apt removes only the real TeX Live packages instead of
# cascading into their reverse dependencies.
# --------------------------------------------------------------------------
purge_debian_texlive() {
  local pkgs
  pkgs="$(dpkg-query -W -f '${Package} ${Status}\n' 'texlive*' 2>/dev/null \
    | awk '$NF == "installed" { print $1 }' \
    | grep -vx 'texlive-local' || true)"
  if [ -z "$pkgs" ]; then
    echo ">> no Debian TeX Live packages installed"
    return 0
  fi
  echo ">> purging Debian TeX Live packages:" $pkgs
  # shellcheck disable=SC2086
  run_noninteractive apt-get purge -y $pkgs
  run_noninteractive apt-get autoremove -y --purge
}

# --------------------------------------------------------------------------
# Register TeX Live's fontconfig snippet so xelatex/lualatex and any non-TeX
# application resolve TL's OpenType/TrueType fonts by name. The system font
# cache is written to /var/cache/fontconfig, which is part of the image, so
# projects do not regenerate it on first use.
# --------------------------------------------------------------------------
integrate_fontconfig() {
  local src dst
  src="$texdir/texmf-var/fonts/conf/texlive-fontconfig.conf"
  dst="/etc/fonts/conf.d/09-texlive.conf"
  if [ ! -r "$src" ]; then
    echo "fontconfig snippet not found at $src; skipping" >&2
    return 0
  fi
  command -v fc-cache >/dev/null || {
    echo "fc-cache not found; skipping fontconfig integration" >&2
    return 0
  }
  $SUDO install -m 0644 "$src" "$dst"
  $SUDO fc-cache -fsv >/dev/null
  echo ">> fontconfig integrated ($dst) and system font cache rebuilt"
}

if [ "$mode" = "install" ]; then
  echo ">> installing TeX Live $year ($scheme) for $tlplatform"

  # Claim the texlive-* namespace before anything else is installed, so the
  # runtime dependencies below cannot drag Debian's TeX Live in as a
  # recommendation or dependency, then reclaim the space the real packages use.
  if [ "$(bool01 "$disable_apt_texlive")" = "1" ]; then
    install_apt_shim
  fi
  if [ "$(bool01 "$purge_apt_texlive")" = "1" ]; then
    purge_debian_texlive
  fi

  ensure_runtime_deps

  # scheme-full without docs/sources is ~4-5 GB; with them roughly double.
  # Warn rather than fail: the builder may legitimately have a smaller disk.
  avail_kb="$(df -Pk /usr/local | awk 'NR==2{print $4}')"
  if [ "$avail_kb" -le "$min_free_kb" ]; then
    echo "WARNING: only ${avail_kb} kB free on /usr/local; $scheme may not fit" >&2
  fi

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  profile="$work/texlive.profile"

  # TEXMFLOCAL sits outside the year directory so local additions survive a
  # yearly upgrade. The ~ paths stay literal on purpose: the installer keeps
  # them so they expand per-user at runtime even though we install as root.
  # instopt_adjustpath 1 symlinks every binary into tlpdbopt_sys_bin.
  cat > "$profile" <<TEXLIVE_PROFILE
selected_scheme $scheme
TEXDIR $texdir
TEXMFLOCAL /usr/local/texlive/texmf-local
TEXMFSYSCONFIG $texdir/texmf-config
TEXMFSYSVAR $texdir/texmf-var
TEXMFCONFIG ~/.texlive/$year/texmf-config
TEXMFHOME ~/texmf
TEXMFVAR ~/.texlive/$year/texmf-var
binary_$tlplatform 1
instopt_adjustpath 1
instopt_adjustrepo 1
instopt_letter $([ "$paper" = "letter" ] && echo 1 || echo 0)
instopt_portable 0
instopt_write18_restricted 1
tlpdbopt_autobackup $(bool01 "$autobackup")
tlpdbopt_backupdir tlpkg/backups
tlpdbopt_create_formats 1
tlpdbopt_desktop_integration 1
tlpdbopt_file_assocs 1
tlpdbopt_generate_updmap 0
tlpdbopt_install_docfiles $(bool01 "$docfiles")
tlpdbopt_install_srcfiles $(bool01 "$srcfiles")
tlpdbopt_post_code 1
tlpdbopt_sys_bin /usr/local/bin
tlpdbopt_sys_info /usr/local/share/info
tlpdbopt_sys_man /usr/local/share/man
tlpdbopt_w32_multi_user 1
TEXLIVE_PROFILE

  echo ">> downloading install-tl from $mirror"
  cd "$work"
  curl -fL -o install-tl-unx.tar.gz "$mirror/install-tl-unx.tar.gz"
  zcat < install-tl-unx.tar.gz | tar xf -
  cd install-tl-2*/

  echo ">> running install-tl (this downloads several GB and takes a while)"
  $SUDO perl ./install-tl --no-interaction --profile="$profile"

  cd /
  trap - EXIT
  rm -rf "$work"
else
  echo ">> updating TeX Live $year"
  [ -x "$tlmgr" ] || {
    echo "no tlmgr at $tlmgr; is TeX Live $year installed?" >&2
    exit 1
  }

  # Honour the mirror input on updates too. instopt_adjustrepo recorded a
  # repository at install time, so without this an explicit mirror override
  # would apply only to fresh installs. Setting it is a no-op for the default.
  $SUDO "$tlmgr" option repository "$mirror"

  # These options are sticky in the tlpdb. Setting them on every run is
  # idempotent and stops an update from dragging docs/sources back in even if
  # the tree was originally built with them enabled.
  $SUDO "$tlmgr" option docfiles "$(bool01 "$docfiles")" >/dev/null
  $SUDO "$tlmgr" option srcfiles "$(bool01 "$srcfiles")" >/dev/null
  $SUDO "$tlmgr" option autobackup "$(bool01 "$autobackup")" >/dev/null

  # tlmgr must update itself before updating packages.
  $SUDO "$tlmgr" update --self
  $SUDO "$tlmgr" update --all --list
  $SUDO "$tlmgr" update --all

  # Re-assert the shim and re-purge, so an image whose base predates this
  # module, or one where something reinstalled Debian's TeX Live, heals on the
  # next monthly build.
  if [ "$(bool01 "$disable_apt_texlive")" = "1" ]; then
    install_apt_shim
  fi
  if [ "$(bool01 "$purge_apt_texlive")" = "1" ]; then
    purge_debian_texlive
  fi

  # An image built before this module existed may lack poppler-utils and
  # friends; install them now so verification runs against a complete tree.
  ensure_runtime_deps
fi

# Runs in both modes: the tree exists by now, and an update can legitimately
# find a package missing if the previous image was built from a narrower scheme.
ensure_tl_packages

# --------------------------------------------------------------------------
# Pre-generate the luaotfload font database into the system tree.
#
# lualatex builds this on first use, which on a scheme-full tree means indexing
# 11k+ fonts and takes minutes. The install profile points TEXMFVAR at
# ~/.texlive/<year>/texmf-var, so a database built by a user lands in $HOME,
# which is not part of the rootfs: it would be rebuilt in every project, by
# every user, on their first Quarto or lualatex PDF render.
#
# Building it here with TEXMFVAR redirected to TEXMFSYSVAR puts it inside the
# image instead, where it is generated once and shipped. Non-fatal: a stale or
# missing database costs time, not correctness.
# --------------------------------------------------------------------------
if [ "$(bool01 "$luaotfload_db")" = "1" ] && command -v luaotfload-tool >/dev/null; then
  echo ">> generating luaotfload font database in $texdir/texmf-var"
  if $SUDO env TEXMFVAR="$texdir/texmf-var" luaotfload-tool --update --quiet; then
    echo ">> luaotfload database generated"
  else
    echo ">> WARNING: luaotfload database generation failed; first render in a project will be slow" >&2
  fi
fi

if [ "$(bool01 "$fontconfig")" = "1" ]; then
  integrate_fontconfig
fi

$SUDO mktexlsr
hash -r 2>/dev/null || true

echo ">> TeX Live $year $mode complete: $(command -v tex || echo 'tex not on PATH')"
