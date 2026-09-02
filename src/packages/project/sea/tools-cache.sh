#!/usr/bin/env bash

# Shared cache helpers for project tools tarball builds.
#
# The cache stores downloaded/static helper binaries only. The cocalc-cli JS
# bundle is intentionally installed after restoring the cache so local CLI code
# changes are always reflected in newly built tools tarballs.
#
# Completed builds retain two generations per platform/flavor and at most 3 GiB
# by default. Set COCALC_PROJECT_TOOLS_CACHE_PRUNE=0 to disable pruning, or tune
# COCALC_PROJECT_TOOLS_CACHE_RETENTION_COUNT,
# COCALC_PROJECT_TOOLS_CACHE_MAX_BYTES, and
# COCALC_PROJECT_TOOLS_CACHE_MIN_AGE_MS.

COCALC_TOOLS_CACHE_HELPERS_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")" && pwd
)"

cocalc_tools_hash_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

cocalc_tools_cache_root() {
  if [ -n "${COCALC_PROJECT_TOOLS_CACHE_DIR:-}" ]; then
    printf '%s\n' "$COCALC_PROJECT_TOOLS_CACHE_DIR"
    return
  fi
  if [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "$XDG_CACHE_HOME/cocalc/project-tools"
    return
  fi
  printf '%s\n' "${HOME:-/tmp}/.cache/cocalc/project-tools"
}

cocalc_tools_cache_key() {
  local root="$1"
  local flavor="$2"
  local os="$3"
  local arch="$4"
  local extra="$5"
  local install_hash
  install_hash="$(cocalc_tools_hash_file "$root/packages/backend/sandbox/install.ts")"
  printf '%s-%s-%s-%s-%s\n' "$flavor" "$os" "$arch" "$extra" "$install_hash"
}

cocalc_tools_restore_cache() {
  local cache_dir="$1"
  local work_dir="$2"
  local cache_root
  cache_root="$(dirname "$cache_dir")"
  mkdir -p "$cache_root"
  (
    flock -s 9
    if [ ! -d "$cache_dir/bin" ]; then
      return 1
    fi
    touch "$cache_dir"
    rm -rf "$work_dir/bin" "$work_dir/share"
    mkdir -p "$work_dir"
    cp -a "$cache_dir/bin" "$work_dir/bin"
    if [ -d "$cache_dir/share" ]; then
      cp -a "$cache_dir/share" "$work_dir/share"
    else
      mkdir -p "$work_dir/share"
    fi
    touch "$cache_dir"
  ) 9>"$cache_root/.cache.lock"
}

cocalc_tools_save_cache() {
  local cache_dir="$1"
  local work_dir="$2"
  local cache_root
  cache_root="$(dirname "$cache_dir")"
  local tmp_dir="${cache_dir}.tmp.$$"
  mkdir -p "$cache_root"
  (
    flock -x 9
    rm -rf "$tmp_dir"
    mkdir -p "$tmp_dir"
    cp -a "$work_dir/bin" "$tmp_dir/bin"
    if [ -d "$work_dir/share" ]; then
      cp -a "$work_dir/share" "$tmp_dir/share"
    fi
    rm -rf "$cache_dir"
    mv "$tmp_dir" "$cache_dir"
  ) 9>"$cache_root/.cache.lock"
}

cocalc_tools_prune_cache() {
  local cache_root="$1"
  shift
  if [ "${COCALC_PROJECT_TOOLS_CACHE_PRUNE:-1}" = "0" ]; then
    return
  fi
  mkdir -p "$cache_root"
  if ! (
    flock -x 9
    node "$COCALC_TOOLS_CACHE_HELPERS_DIR/tools-cache-prune.cjs" \
      "$cache_root" "$@"
  ) 9>"$cache_root/.cache.lock"; then
    echo "Warning: unable to prune project tools cache at $cache_root" >&2
  fi
}
