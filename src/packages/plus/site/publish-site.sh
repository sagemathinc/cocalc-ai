#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE_FILE="$SCRIPT_DIR/index.html"
INSTALL_FILE="$SCRIPT_DIR/../install.sh"

if [ ! -f "$SITE_FILE" ]; then
  echo "Site artifact not found: $SITE_FILE" >&2
  exit 1
fi

if [ ! -f "$INSTALL_FILE" ]; then
  echo "Installer not found: $INSTALL_FILE" >&2
  exit 1
fi

SITE_KEY="${COCALC_R2_SITE_KEY:-software/cocalc-plus/index.html}"
INSTALL_KEY="${COCALC_R2_INSTALL_KEY:-software/cocalc-plus/install.sh}"
ALIAS_KEY="${COCALC_R2_ALIAS_KEY:-software/cocalc-plus}"
ALIAS_SLASH_KEY="${COCALC_R2_ALIAS_SLASH_KEY:-software/cocalc-plus/}"

node ../../cloud/scripts/publish-r2.js \
  --file "$SITE_FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$SITE_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"

node ../../cloud/scripts/publish-r2.js \
  --file "$INSTALL_FILE" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$INSTALL_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/x-shellscript; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"

alias_file="$(mktemp)"
cat > "$alias_file" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=/software/cocalc-plus/index.html">
<link rel="canonical" href="/software/cocalc-plus/index.html">
<title>Redirecting…</title>
<p>Redirecting to <a href="/software/cocalc-plus/index.html">/software/cocalc-plus/index.html</a>…</p>
EOF

node ../../cloud/scripts/publish-r2.js \
  --file "$alias_file" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$ALIAS_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"

node ../../cloud/scripts/publish-r2.js \
  --file "$alias_file" \
  --bucket "${COCALC_R2_BUCKET:-}" \
  --key "$ALIAS_SLASH_KEY" \
  --public-base-url "${COCALC_R2_PUBLIC_BASE_URL:-}" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "${COCALC_R2_CACHE_CONTROL:-public, max-age=300}"

rm -f "$alias_file"
