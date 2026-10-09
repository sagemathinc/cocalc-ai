#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/bay-bootstrap-release.sh"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

ORIGINAL_NODE="$(command -v node)"
NODE_VERSION="test"
NVM_DIR="${TMP_ROOT}/nvm"
mkdir -p "${NVM_DIR}/versions/node/v${NODE_VERSION}/bin"
ln -s "$ORIGINAL_NODE" "${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node"
if [[ "$(PATH=/nonexistent find_node)" != "${NVM_DIR}/versions/node/v${NODE_VERSION}/bin/node" ]]; then
  echo "configured Node runtime was not resolved when node was absent from PATH" >&2
  exit 1
fi

INSTALL_BASE="${TMP_ROOT}/bay"
RELEASES_DIR="${INSTALL_BASE}/releases"
CURRENT_LINK="${INSTALL_BASE}/current"
BAY_ROOT="${TMP_ROOT}/state-root"
COCALC_BAY_PROC_ROOT="${TMP_ROOT}/proc"
# shellcheck disable=SC2034
RETAIN_RELEASES=2

mkdir -p "${RELEASES_DIR}" "${BAY_ROOT}/state" "${COCALC_BAY_PROC_ROOT}/123"
for release in \
  050-stale \
  100-live-hub \
  200-static \
  300-static \
  400-static \
  500-static; do
  mkdir -p "${RELEASES_DIR}/${release}"
done

ln -s "${RELEASES_DIR}/500-static" "$CURRENT_LINK"
printf '%s\n' 400-static > "${BAY_ROOT}/state/previous-version"
ln -s "${RELEASES_DIR}/100-live-hub" "${COCALC_BAY_PROC_ROOT}/123/cwd"

prune_old_releases

for release in 100-live-hub 400-static 500-static; do
  if [[ ! -d "${RELEASES_DIR}/${release}" ]]; then
    echo "expected retained release is missing: ${release}" >&2
    exit 1
  fi
done

for release in 050-stale 200-static 300-static; do
  if [[ -e "${RELEASES_DIR}/${release}" ]]; then
    echo "expected stale release still exists: ${release}" >&2
    exit 1
  fi
done

PREVIOUS_RELEASE="${TMP_ROOT}/previous-release"
TARGET_RELEASE="${TMP_ROOT}/target-release"
PREVIOUS_CDN="${PREVIOUS_RELEASE}/runtime/control-plane/cdn"
TARGET_CDN="${TARGET_RELEASE}/runtime/control-plane/cdn"
mkdir -p \
  "${PREVIOUS_CDN}/codemirror" \
  "${PREVIOUS_CDN}/codemirror-0.9" \
  "${TARGET_CDN}/codemirror"
printf '%s\n' old >"${PREVIOUS_CDN}/codemirror/content.txt"
printf '%s\n' historic >"${PREVIOUS_CDN}/codemirror-0.9/content.txt"
printf '%s\n' new >"${TARGET_CDN}/codemirror/content.txt"
ln -s codemirror "${PREVIOUS_CDN}/codemirror-1.0"
ln -s codemirror "${TARGET_CDN}/codemirror-2.0"
cat >"${PREVIOUS_CDN}/index.js" <<'EOF'
exports.versions = { codemirror: "1.0" };
EOF
cat >"${TARGET_CDN}/index.js" <<'EOF'
exports.versions = { codemirror: "2.0" };
EOF

preserve_previous_cdn_assets "$PREVIOUS_RELEASE"

if [[ "$(cat "${TARGET_CDN}/codemirror-2.0/content.txt")" != "new" ]]; then
  echo "current CDN version was overwritten" >&2
  exit 1
fi
if [[ "$(cat "${TARGET_CDN}/codemirror-1.0/content.txt")" != "old" ]]; then
  echo "previous CDN version was not retained" >&2
  exit 1
fi
if [[ -L "${TARGET_CDN}/codemirror-1.0" ]]; then
  echo "previous CDN version must be retained as a real directory" >&2
  exit 1
fi
if [[ "$(cat "${TARGET_CDN}/codemirror-0.9/content.txt")" != "historic" ]]; then
  echo "historic CDN version was not retained" >&2
  exit 1
fi

ASSET_RELEASES="${TMP_ROOT}/asset-releases"
ASSET_PREVIOUS="${ASSET_RELEASES}/previous"
ASSET_TARGET="${ASSET_RELEASES}/target"
CURRENT_LINK="${TMP_ROOT}/asset-current"
TARGET_RELEASE="$ASSET_TARGET"
mkdir -p \
  "${ASSET_PREVIOUS}/runtime/control-plane/static" \
  "${ASSET_TARGET}/runtime/control-plane/static"
ln -s "$ASSET_PREVIOUS" "$CURRENT_LINK"
printf '%s\n' previous > \
  "${ASSET_PREVIOUS}/runtime/control-plane/static/previous-0123456789abcdef.js"
printf '%s\n' historic > \
  "${ASSET_PREVIOUS}/runtime/control-plane/static/historic-aaaaaaaaaaaaaaaa.js"
printf '%s\n' appledouble > \
  "${ASSET_PREVIOUS}/runtime/control-plane/static/._historic-bbbbbbbbbbbbbbbb.js"
cat >"${ASSET_PREVIOUS}/runtime/control-plane/static/frontend-build.json" <<'EOF'
{"schema":1,"fingerprint":"previous","build_timestamp":1,"assets":["previous-0123456789abcdef.js"]}
EOF
printf '%s\n' current > \
  "${ASSET_TARGET}/runtime/control-plane/static/current-fedcba9876543210.js"
cat >"${ASSET_TARGET}/runtime/control-plane/static/frontend-build.json" <<'EOF'
{"schema":1,"fingerprint":"current","build_timestamp":2,"assets":["current-fedcba9876543210.js"]}
EOF

preserve_previous_static_assets
prepare_frontend_asset_history >/dev/null

if [[ ! -f "${ASSET_TARGET}/runtime/control-plane/static/previous-0123456789abcdef.js" ]]; then
  echo "previous frontend asset was not retained" >&2
  exit 1
fi
if [[ -e "${ASSET_TARGET}/runtime/control-plane/static/._historic-bbbbbbbbbbbbbbbb.js" ]]; then
  echo "AppleDouble frontend metadata was retained" >&2
  exit 1
fi
node - "${ASSET_TARGET}/runtime/control-plane/static/frontend-build-history.json" <<'NODE'
const fs = require("node:fs");
const history = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (history.builds.length !== 2) throw new Error("expected two frontend builds");
if (!history.builds[0].assets.includes("current-fedcba9876543210.js")) {
  throw new Error("current frontend assets missing from history");
}
if (!history.builds[1].assets.includes("previous-0123456789abcdef.js")) {
  throw new Error("previous frontend assets missing from history");
}
if (!history.builds[1].assets.includes("historic-aaaaaaaaaaaaaaaa.js")) {
  throw new Error("historic retained frontend assets missing from history");
}
if (history.builds.some(({ assets }) => assets.some((asset) => asset.startsWith("._")))) {
  throw new Error("AppleDouble frontend metadata included in history");
}
NODE

# A previous manifest overlaps the on-disk scan; count each retained file once.
node - "${ASSET_PREVIOUS}/runtime/control-plane/static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const assets = Array.from({ length: 6000 }, (_, i) => `chunk-${i}-0123456789abcdef.js`);
for (const asset of assets) fs.writeFileSync(path.join(root, asset), "fixture");
fs.writeFileSync(path.join(root, "frontend-build.json"), JSON.stringify({ assets }));
NODE
preserve_previous_static_assets
prepare_frontend_asset_history >/dev/null
node - "${ASSET_TARGET}/runtime/control-plane/static/frontend-build-history.json" <<'NODE'
const fs = require("node:fs");
const history = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (history.builds[1].assets.length !== 6002) {
  throw new Error("overlapping manifest/scan assets were not deduplicated");
}
NODE

# A genuinely oversized unique inventory must still fail before activation.
node - "${ASSET_PREVIOUS}/runtime/control-plane/static/frontend-build.json" <<'NODE'
const fs = require("node:fs");
const assets = Array.from({ length: 10001 }, (_, i) => `chunk-${i}-0123456789abcdef.js`);
fs.writeFileSync(process.argv[2], JSON.stringify({ assets }));
NODE
if prepare_frontend_asset_history >"${TMP_ROOT}/oversized-assets.log" 2>&1; then
  echo "oversized unique frontend inventory unexpectedly passed" >&2
  exit 1
fi
grep -q 'frontend asset manifest exceeds 10000 files' "${TMP_ROOT}/oversized-assets.log"

VALIDATION_RELEASE="${TMP_ROOT}/validation-release"
TARGET_RELEASE="$VALIDATION_RELEASE"
OVERLAY_MODE="rocket-bundle"
HUB_BUNDLE_PATH="${TMP_ROOT}/hub.tar.xz"
STATIC_BUNDLE_PATH=""
for required_file in \
  scripts/bay-systemd/install-scaffold.sh \
  scripts/bay-systemd/env/bay-rocket-bundle-overlay.env.example \
  scripts/bay-systemd/needrestart/cocalc-bay.conf \
  runtime/project-host/index.js \
  runtime/control-plane/bundle/index.js \
  runtime/control-plane/http-api-dist/pages/api/v2/index.js \
  runtime/migrate-schema/index.js \
  runtime/control-plane/static/public.html \
  runtime/control-plane/public/cocalc-content.css \
  runtime/control-plane/webapp/favicon.ico \
  runtime/control-plane/bundle/gcp/gcp-setup.sh \
  runtime/control-plane/bundle/gcp/compute-vm-setup.sh \
  runtime/control-plane/bundle/nebius/nebius-setup.sh; do
  mkdir -p "${VALIDATION_RELEASE}/$(dirname "$required_file")"
  touch "${VALIDATION_RELEASE}/${required_file}"
done
chmod +x "${VALIDATION_RELEASE}/scripts/bay-systemd/install-scaffold.sh"

rm "${VALIDATION_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
if (validate_release >/dev/null 2>&1); then
  echo "release unexpectedly passed without the needrestart policy" >&2
  exit 1
fi
touch "${VALIDATION_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf"

NEEDRESTART_POLICY_PATH="${TMP_ROOT}/etc/needrestart/conf.d/cocalc-bay.conf"
printf '%s\n' 'test needrestart policy' \
  >"${VALIDATION_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
# (Installs from the trusted scaffold copy; here a stand-in for one.)
TRUSTED_SCAFFOLD_DIR="${VALIDATION_RELEASE}/scripts/bay-systemd"
install_needrestart_policy >/dev/null
TRUSTED_SCAFFOLD_DIR=""
if [[ "$(cat "$NEEDRESTART_POLICY_PATH")" != "test needrestart policy" ]]; then
  echo "static release needrestart policy was not installed" >&2
  exit 1
fi

# Hub-only releases must remain deployable over static releases that predate
# the bundled CDN. Static and full releases still fail closed without it.
validate_release
HUB_BUNDLE_PATH=""
if (validate_release >/dev/null 2>&1); then
  echo "non-hub release unexpectedly passed without CDN assets" >&2
  exit 1
fi
mkdir -p "${VALIDATION_RELEASE}/runtime/control-plane/cdn/pdfjs-dist/cmaps"
touch "${VALIDATION_RELEASE}/runtime/control-plane/cdn/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap"
validate_release

# Bay services log errors and warnings to the console (journald), never to a
# file, on full and hub-only releases alike.
ENV_DIR="${TMP_ROOT}/etc-cocalc"
mkdir -p "$ENV_DIR"
printf 'FOO=1\nDEBUG=cocalc:*\nDEBUG_FILE=/tmp/x.log\n' >"${ENV_DIR}/bay.env"
JOURNALD_CAP_FILE="${TMP_ROOT}/missing-journald-cap.conf" \
  configure_bay_logging_env 2>"${TMP_ROOT}/logging-env.err"
expected_env=$'FOO=1\nDEBUG=cocalc:error:*,cocalc:warn:*\nDEBUG_FILE=\nDEBUG_CONSOLE=yes'
if [[ "$(cat "${ENV_DIR}/bay.env")" != "$expected_env" ]]; then
  echo "bay logging env was not written as expected:" >&2
  cat "${ENV_DIR}/bay.env" >&2
  exit 1
fi
grep -q 'journald has no CoCalc size cap' "${TMP_ROOT}/logging-env.err"
touch "${TMP_ROOT}/journald-cap.conf"
JOURNALD_CAP_FILE="${TMP_ROOT}/journald-cap.conf" \
  configure_bay_logging_env 2>"${TMP_ROOT}/logging-env.err"
if [[ -s "${TMP_ROOT}/logging-env.err" ]]; then
  echo "journald cap warning printed although the cap exists" >&2
  exit 1
fi
if ! awk '/^  if \[\[ -n "\$HUB_BUNDLE_PATH" \]\]; then$/ { hub = 1 }
    hub && /configure_bay_logging_env/ { found = 1 }
    hub && /exit 0/ { exit !found }' "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "hub-only releases do not configure bay logging" >&2
  exit 1
fi

# The installer root runs comes from a root-owned copy of the bundle's (or
# source tree's) scaffold, never from the bay-owned release directory.
scaffold_bundle_root="${TMP_ROOT}/scaffold-bundle/cocalc-bay-test"
mkdir -p "${scaffold_bundle_root}/scripts/bay-systemd/bin" "${scaffold_bundle_root}/runtime"
printf '#!/usr/bin/env bash\necho trusted-installer\n' > "${scaffold_bundle_root}/scripts/bay-systemd/install-scaffold.sh"
chmod 0777 "${scaffold_bundle_root}/scripts/bay-systemd/install-scaffold.sh"
printf 'helper\n' > "${scaffold_bundle_root}/scripts/bay-systemd/bin/helper"
printf 'runtime\n' > "${scaffold_bundle_root}/runtime/index.js"
tar -czf "${TMP_ROOT}/scaffold-bundle.tar.gz" -C "${TMP_ROOT}/scaffold-bundle" cocalc-bay-test
SCAFFOLD_STAGE_PARENT="${TMP_ROOT}"
TARGET_RELEASE="${TMP_ROOT}/tampered-release"
mkdir -p "${TARGET_RELEASE}/scripts/bay-systemd"
printf '#!/usr/bin/env bash\necho tampered\n' > "${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh"
check_trusted_scaffold() {
  [[ "$TRUSTED_SCAFFOLD_DIR" == "${TMP_ROOT}"/cocalc-bay-scaffold.*/scripts/bay-systemd ]] || {
    echo "scaffold not staged outside the release: $TRUSTED_SCAFFOLD_DIR" >&2
    exit 1
  }
  [[ "$("${TRUSTED_SCAFFOLD_DIR}/install-scaffold.sh")" == trusted-installer ]] || {
    echo "staged installer is not the bundle's" >&2
    exit 1
  }
  if find "$(dirname "$(dirname "$TRUSTED_SCAFFOLD_DIR")")" -perm /022 | grep -q .; then
    echo "staged scaffold is group- or world-writable" >&2
    exit 1
  fi
}
BUNDLE_PATH="${TMP_ROOT}/scaffold-bundle.tar.gz"
HUB_BUNDLE_PATH=""
stage_trusted_scaffold >/dev/null
check_trusted_scaffold
if [[ -e "$(dirname "$(dirname "$TRUSTED_SCAFFOLD_DIR")")/runtime" ]]; then
  echo "staged more of the bundle than its scaffold" >&2
  exit 1
fi
staged="$(dirname "$(dirname "$TRUSTED_SCAFFOLD_DIR")")"
remove_trusted_scaffold
[[ ! -e "$staged" ]] || { echo "staged scaffold not removed" >&2; exit 1; }
BUNDLE_PATH=""
HUB_BUNDLE_PATH="${TMP_ROOT}/scaffold-bundle.tar.gz"
stage_trusted_scaffold >/dev/null
check_trusted_scaffold
remove_trusted_scaffold
HUB_BUNDLE_PATH=""
SOURCE_ROOT="$scaffold_bundle_root"
stage_trusted_scaffold >/dev/null
check_trusted_scaffold
remove_trusted_scaffold
# A static deploy installs only the needrestart policy (Perl that root
# evaluates), also from a trusted copy of its bundle.
static_root="${TMP_ROOT}/static-bundle/cocalc-bay-static-test"
mkdir -p "${static_root}/scripts/bay-systemd/needrestart"
printf '# trusted policy\n' > "${static_root}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
tar -czf "${TMP_ROOT}/static-bundle.tar.gz" -C "${TMP_ROOT}/static-bundle" cocalc-bay-static-test
mkdir -p "${TARGET_RELEASE}/scripts/bay-systemd/needrestart"
printf 'system("touch /tmp/pwned");\n' > "${TARGET_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
STATIC_BUNDLE_PATH="${TMP_ROOT}/static-bundle.tar.gz"
SOURCE_ROOT=""
NEEDRESTART_POLICY_PATH="${TMP_ROOT}/installed-needrestart.conf"
stage_trusted_scaffold needrestart >/dev/null
install_needrestart_policy >/dev/null
remove_trusted_scaffold
[[ "$(cat "$NEEDRESTART_POLICY_PATH")" == "# trusted policy" ]] ||
  { echo "needrestart policy did not come from the bundle" >&2; exit 1; }
STATIC_BUNDLE_PATH=""
# Nothing root reads into /etc (overlay env, needrestart) comes from the
# release, and the CDN preservation runs its code and copies as the bay user.
if grep -nE '(cat|<) "\$\{TARGET_RELEASE\}' "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "root reads configuration from the release directory" >&2
  exit 1
fi
grep -q 'run "\${as_bay\[@\]}" cp -aL' "${SCRIPT_DIR}/bay-bootstrap-release.sh" ||
  { echo "CDN copies are not made as the bay user" >&2; exit 1; }
grep -q '"\${as_bay\[@\]}" "\$node_bin" -' "${SCRIPT_DIR}/bay-bootstrap-release.sh" ||
  { echo "the previous release's CDN index is not loaded as the bay user" >&2; exit 1; }
if grep -n 'INSTALL_CMD.*TARGET_RELEASE\|"\${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh"$' \
  "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "an installer still runs from the release directory" >&2
  exit 1
fi

echo "bay release pruning and CDN retention tests passed"
