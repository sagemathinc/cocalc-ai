#!/usr/bin/env bash

resolve_sea_node_bin() {
  local requested="${COCALC_SEA_NODE_BIN:-}"
  local node_bin=""
  local version=""
  local major=""

  if [[ -z "$requested" ]]; then
    requested="node"
  fi

  case "$requested" in
    */*)
      node_bin="$requested"
      ;;
    *)
      node_bin="$(command -v "$requested" || true)"
      ;;
  esac

  if [[ -z "$node_bin" || ! -x "$node_bin" ]]; then
    echo "ERROR: unable to find executable Node.js binary: $requested" >&2
    echo "Set COCALC_SEA_NODE_BIN to the Node 26 binary to use for SEA builds." >&2
    return 1
  fi

  version="$("$node_bin" -p 'process.versions.node' 2>/dev/null || true)"
  major="${version%%.*}"
  if [[ "$major" != "26" ]]; then
    echo "ERROR: SEA builds require Node.js 26; got ${version:-unknown} at $node_bin" >&2
    echo "Set COCALC_SEA_NODE_BIN=/path/to/node-v26/bin/node or put Node 26 first in PATH." >&2
    return 1
  fi

  printf '%s\n' "$node_bin"
}
