set -euo pipefail

packages="${PACKAGES:?packages are required}"

for pkg in $packages; do
  dpkg-query -W -f='${Status}' "$pkg" | grep -q "install ok installed"
done

case " $packages " in
  *" htop "*)
    command -v htop
    if [ "${HTOP_HIDE_THREADS:-true}" = "true" ]; then
      test -s /etc/htoprc
      grep -q '^hide_kernel_threads=1$' /etc/htoprc
      grep -q '^hide_userland_threads=1$' /etc/htoprc
    fi
    ;;
esac
