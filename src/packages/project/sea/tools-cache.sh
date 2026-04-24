#!/usr/bin/env bash

# Shared cache helpers for project tools tarball builds.
#
# The cache stores downloaded/static helper binaries only. The cocalc-cli JS
# bundle is intentionally installed after restoring the cache so local CLI code
# changes are always reflected in newly built tools tarballs.

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
  if [ ! -d "$cache_dir/bin" ]; then
    return 1
  fi
  rm -rf "$work_dir/bin" "$work_dir/share"
  mkdir -p "$work_dir"
  cp -a "$cache_dir/bin" "$work_dir/bin"
  if [ -d "$cache_dir/share" ]; then
    cp -a "$cache_dir/share" "$work_dir/share"
  else
    mkdir -p "$work_dir/share"
  fi
  return 0
}

cocalc_tools_save_cache() {
  local cache_dir="$1"
  local work_dir="$2"
  local tmp_dir="${cache_dir}.tmp.$$"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir"
  cp -a "$work_dir/bin" "$tmp_dir/bin"
  if [ -d "$work_dir/share" ]; then
    cp -a "$work_dir/share" "$tmp_dir/share"
  fi
  mkdir -p "$(dirname "$cache_dir")"
  rm -rf "$cache_dir"
  mv "$tmp_dir" "$cache_dir"
}
