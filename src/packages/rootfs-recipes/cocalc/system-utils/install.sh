set -euo pipefail

# Interactive tools someone reaches for in a terminal, plus the site-wide
# configuration that makes them behave sensibly in an image.
#
# The configuration is the reason this is not just a cocalc/apt step. Tools
# like htop keep their settings in the user's home directory, which is user
# data and is not captured in a RootFS image, so a default has to be written
# somewhere the tool falls back to.

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

packages="${PACKAGES:?packages are required}"

$SUDO apt-get update
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $packages
$SUDO apt-get clean
$SUDO rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# htop reads /etc/htoprc when the user has no ~/.config/htop/htoprc, and on
# first quit writes their own config seeded from it. So these values act as
# defaults for every new user and then persist, even though /etc/htoprc stops
# being consulted for that user afterwards.
#
# Only the keys that differ from htop's own defaults are listed. Pinning a full
# layout would go stale across htop releases, and missing keys already fall
# back to the built-in defaults.
case " $packages " in
  *" htop "*)
    if [ "${HTOP_HIDE_THREADS:-true}" = "true" ]; then
      echo ">> writing /etc/htoprc"
      $SUDO tee /etc/htoprc >/dev/null <<'HTOPRC'
hide_kernel_threads=1
hide_userland_threads=1
HTOPRC
      $SUDO chmod 644 /etc/htoprc
    fi
    ;;
esac
