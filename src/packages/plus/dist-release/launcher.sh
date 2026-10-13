#!/bin/sh
# CoCalc Plus launcher (pointer format v1).
#
# Installed by https://software.cocalc.ai/software/plus/install.sh and
# replaced only by `cocalc-plus update`. It never parses JSON: it reads the
# one-line `active` pointer
#   v1 <manifest> <node> <bootstrap> <manifest>
# (four sha256 hashes; the last names the assembled release directory
# apps/<manifest>), checks it, and runs the pinned Node on the bootstrap.

root="${COCALC_PLUS_DIST_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/cocalc/plus}"

broken() {
  origin=""
  if [ -f "$root/origin" ]; then
    IFS= read -r origin <"$root/origin" || origin=""
  fi
  case "$origin" in
    http://* | https://*)
      case "$origin" in
        *[!A-Za-z0-9.:/_-]*) origin="" ;;
      esac
      ;;
    *) origin="" ;;
  esac
  [ -n "$origin" ] || origin="https://software.cocalc.ai/software/plus"
  printf 'cocalc-plus: %s\n' "$1" >&2
  printf 'To repair it, reinstall: curl -fsSL %s/install.sh | sh\n' "$origin" >&2
  exit 1
}

active="$root/active"
if [ ! -f "$active" ] || [ -L "$active" ]; then
  broken "the CoCalc Plus installation is missing or incomplete ($active)."
fi
size=$(wc -c <"$active" | tr -d ' ')
if [ "$size" != 263 ]; then
  broken "the active pointer is malformed ($active)."
fi
line=""
IFS= read -r line <"$active" || broken "the active pointer is malformed ($active)."
if [ "${#line}" -ne 262 ]; then
  broken "the active pointer is malformed ($active)."
fi
case "$line" in
  "v1 "*) ;;
  *) broken "the active pointer has an unknown format ($active)." ;;
esac
rest=${line#v1 }
manifest=${rest%% *}
rest=${rest#* }
node=${rest%% *}
rest=${rest#* }
bootstrap=${rest%% *}
app=${rest#* }
for hash in "$manifest" "$node" "$bootstrap" "$app"; do
  if [ "${#hash}" -ne 64 ]; then
    broken "the active pointer is malformed ($active)."
  fi
  case "$hash" in
    *[!0-9a-f]*) broken "the active pointer is malformed ($active)." ;;
  esac
done
if [ "$app" != "$manifest" ]; then
  broken "the active pointer is malformed ($active)."
fi
for dir in "node/$node" "targets/$bootstrap" "apps/$app"; do
  if [ ! -d "$root/$dir" ] || [ -L "$root/$dir" ]; then
    broken "part of CoCalc Plus is missing ($root/$dir)."
  fi
done
if [ ! -x "$root/node/$node/bin/node" ]; then
  broken "the Node runtime is missing ($root/node/$node/bin/node)."
fi

unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
COCALC_PLUS_DIST_ROOT=$root
COCALC_PLUS_ACTIVE=$line
export COCALC_PLUS_DIST_ROOT COCALC_PLUS_ACTIVE
exec "$root/node/$node/bin/node" "$root/targets/$bootstrap/bootstrap.js" \
  "$root/apps/$app/bundle/index.js" "$@"
