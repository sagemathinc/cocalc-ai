#!/bin/sh
# CoCalc CLI launcher (pointer format v1).
#
# Installed by <site>/cli/install.sh and replaced only by `cocalc update`.
# It never parses JSON: it reads the one-line `active` pointer
#   v1 <manifest> <node> <bootstrap> <bundle>
# (four sha256 hashes), checks it, and runs the pinned Node on the bootstrap,
# which checks the bundle's hash and runs it.

root="${COCALC_CLI_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/cocalc/cli}"

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
  printf 'cocalc: %s\n' "$1" >&2
  if [ -n "$origin" ]; then
    printf 'To repair it, reinstall: curl -fsSL %s/cli/install.sh | sh\n' "$origin" >&2
  else
    printf 'To repair it, reinstall from your CoCalc site: curl -fsSL <site>/cli/install.sh | sh\n' >&2
  fi
  exit 1
}

active="$root/active"
if [ ! -f "$active" ] || [ -L "$active" ]; then
  broken "the CLI installation is missing or incomplete ($active)."
fi
size=$(wc -c <"$active" | tr -d ' ')
if [ "$size" != 263 ]; then
  broken "the CLI's active pointer is malformed ($active)."
fi
line=""
IFS= read -r line <"$active" || broken "the CLI's active pointer is malformed ($active)."
if [ "${#line}" -ne 262 ]; then
  broken "the CLI's active pointer is malformed ($active)."
fi
case "$line" in
  "v1 "*) ;;
  *) broken "the CLI's active pointer has an unknown format ($active)." ;;
esac
rest=${line#v1 }
manifest=${rest%% *}
rest=${rest#* }
node=${rest%% *}
rest=${rest#* }
bootstrap=${rest%% *}
bundle=${rest#* }
for hash in "$manifest" "$node" "$bootstrap" "$bundle"; do
  if [ "${#hash}" -ne 64 ]; then
    broken "the CLI's active pointer is malformed ($active)."
  fi
  case "$hash" in
    *[!0-9a-f]*) broken "the CLI's active pointer is malformed ($active)." ;;
  esac
done
for dir in "node/$node" "targets/$bootstrap" "targets/$bundle"; do
  if [ ! -d "$root/$dir" ] || [ -L "$root/$dir" ]; then
    broken "part of the installed CLI is missing ($root/$dir)."
  fi
done
if [ ! -x "$root/node/$node/bin/node" ]; then
  broken "the CLI's Node runtime is missing ($root/node/$node/bin/node)."
fi

unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE
COCALC_CLI_ROOT=$root
COCALC_CLI_ACTIVE=$line
export COCALC_CLI_ROOT COCALC_CLI_ACTIVE
exec "$root/node/$node/bin/node" "$root/targets/$bootstrap/bootstrap.js" \
  "$root/targets/$bundle/cocalc.js" "$@"
