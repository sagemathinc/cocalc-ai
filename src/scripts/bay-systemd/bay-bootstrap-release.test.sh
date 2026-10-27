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

# These fixtures have build timestamps 1 and 2: keep every inherited build.
export FRONTEND_ASSET_RETENTION_CUTOFF_MS=0
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

# Regression (prod 10-18): the previous release holds every chunk carried
# forward (10067 hashed files) but declares only its own 1115. The whole
# retained set is listed and the deploy passes under the 11000 cap.
rm -f "${ASSET_PREVIOUS}"/runtime/control-plane/static/chunk-* \
  "${ASSET_PREVIOUS}"/runtime/control-plane/static/historic-* \
  "${ASSET_PREVIOUS}"/runtime/control-plane/static/previous-*
node - "${ASSET_PREVIOUS}/runtime/control-plane/static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
for (let i = 0; i < 10067; i++) {
  fs.writeFileSync(path.join(root, `retained-${i}-0123456789abcdef.js`), "fixture");
}
const assets = Array.from({ length: 1115 }, (_, i) => `retained-${i}-0123456789abcdef.js`);
fs.writeFileSync(path.join(root, "frontend-build.json"), JSON.stringify({ assets }));
NODE
preserve_previous_static_assets
prepare_frontend_asset_history >/dev/null
node - "${ASSET_TARGET}/runtime/control-plane/static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const history = JSON.parse(fs.readFileSync(path.join(root, "frontend-build-history.json"), "utf8"));
const retained = history.builds[1].assets.filter((asset) => asset.startsWith("retained-"));
if (retained.length !== 10067) {
  throw new Error(`previous build lists ${retained.length} retained chunks, expected 10067`);
}
const onDisk = fs.readdirSync(root).filter((name) => name.startsWith("retained-")).length;
if (onDisk !== 10067) throw new Error(`carried ${onDisk} retained chunks forward, expected 10067`);
NODE

# Each build under the cap but their union over it fails before activation,
# as the hub monitor and software smoke would reject that history.
node - "${ASSET_TARGET}/runtime/control-plane/static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const assets = Array.from({ length: 934 }, (_, i) => `fresh-${i}-0123456789abcdef.js`);
for (const asset of assets) fs.writeFileSync(path.join(root, asset), "fixture");
fs.writeFileSync(path.join(root, "frontend-build.json"), JSON.stringify({ assets }));
NODE
if prepare_frontend_asset_history >"${TMP_ROOT}/union-assets.log" 2>&1; then
  echo "an asset union over the cap unexpectedly passed" >&2
  exit 1
fi
grep -q 'frontend asset history exceeds 11000 files' "${TMP_ROOT}/union-assets.log"
node - "${ASSET_TARGET}/runtime/control-plane/static" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const assets = Array.from({ length: 933 }, (_, i) => `fresh-${i}-0123456789abcdef.js`);
fs.writeFileSync(path.join(root, "frontend-build.json"), JSON.stringify({ assets }));
NODE
prepare_frontend_asset_history >"${TMP_ROOT}/near-cap.log"
# At the cap the deploy passes, but warns that the required browser version
# needs raising.
grep -q '^WARNING: frontend asset history has 11000 of 11000 files (100%).*Raise "Required browser version"' \
  "${TMP_ROOT}/near-cap.log"

# A genuinely oversized unique inventory must still fail before activation.
node - "${ASSET_PREVIOUS}/runtime/control-plane/static/frontend-build.json" <<'NODE'
const fs = require("node:fs");
const assets = Array.from({ length: 11001 }, (_, i) => `chunk-${i}-0123456789abcdef.js`);
fs.writeFileSync(process.argv[2], JSON.stringify({ assets }));
NODE
if prepare_frontend_asset_history >"${TMP_ROOT}/oversized-assets.log" 2>&1; then
  echo "oversized unique frontend inventory unexpectedly passed" >&2
  exit 1
fi
grep -q 'frontend asset manifest exceeds 11000 files' "${TMP_ROOT}/oversized-assets.log"

# Retention: inherited chunks are kept only for builds at or after the cutoff
# (the required browser version); the ledger keeps each build's own assets.
RET_RELEASES="${TMP_ROOT}/retention-releases"
RET_PREVIOUS="${RET_RELEASES}/previous"
RET_TARGET="${RET_RELEASES}/target"
RET_PREV_STATIC="${RET_PREVIOUS}/runtime/control-plane/static"
RET_STATIC="${RET_TARGET}/runtime/control-plane/static"
CURRENT_LINK="${TMP_ROOT}/retention-current"
TARGET_RELEASE="$RET_TARGET"
mkdir -p "$RET_PREV_STATIC" "$RET_STATIC"
ln -sfn "$RET_PREVIOUS" "$CURRENT_LINK"
NOW_MS="$(($(date +%s) * 1000))"
DAY_MS=86400000
for asset in \
  previous-1111111111111111.js \
  mid-2222222222222222.js \
  old-3333333333333333.js \
  shared-4444444444444444.js \
  unlisted-5555555555555555.js; do
  printf '%s\n' "$asset" >"${RET_PREV_STATIC}/${asset}"
done
printf '{"schema":1,"fingerprint":"previous","build_timestamp":%s,"assets":["previous-1111111111111111.js"]}\n' \
  "$((NOW_MS - 2 * DAY_MS))" >"${RET_PREV_STATIC}/frontend-build.json"
printf '{"schema":1,"builds":[%s,%s,%s]}\n' \
  "{\"fingerprint\":\"previous\",\"build_timestamp\":$((NOW_MS - 2 * DAY_MS)),\"assets\":[\"previous-1111111111111111.js\"]}" \
  "{\"fingerprint\":\"mid\",\"build_timestamp\":$((NOW_MS - 5 * DAY_MS)),\"assets\":[\"mid-2222222222222222.js\"]}" \
  "{\"fingerprint\":\"old\",\"build_timestamp\":$((NOW_MS - 20 * DAY_MS)),\"assets\":[\"old-3333333333333333.js\",\"shared-4444444444444444.js\",\"gone-6666666666666666.js\"]}" \
  >"${RET_PREVIOUS}/runtime/control-plane/frontend-asset-ledger.json"
printf '%s\n' current >"${RET_STATIC}/current-7777777777777777.js"
printf '%s\n' shared >"${RET_STATIC}/shared-4444444444444444.js"
printf '{"schema":1,"fingerprint":"current","build_timestamp":%s,"assets":["current-7777777777777777.js","shared-4444444444444444.js"]}\n' \
  "$NOW_MS" >"${RET_STATIC}/frontend-build.json"
export FRONTEND_ASSET_RETENTION_CUTOFF_MS="$((NOW_MS - 10 * DAY_MS))"
preserve_previous_static_assets
prepare_frontend_asset_history >"${TMP_ROOT}/retention.log"
for asset in previous-1111111111111111.js mid-2222222222222222.js \
  current-7777777777777777.js shared-4444444444444444.js \
  unlisted-5555555555555555.js; do
  if [[ ! -f "${RET_STATIC}/${asset}" ]]; then
    echo "retention removed a frontend asset it must keep: ${asset}" >&2
    exit 1
  fi
done
if [[ -e "${RET_STATIC}/old-3333333333333333.js" ]]; then
  echo "retention kept a chunk of a build older than the cutoff" >&2
  exit 1
fi
if grep -q '^WARNING' "${TMP_ROOT}/retention.log"; then
  echo "a small history must not warn" >&2
  exit 1
fi
if ! grep -q 'frontend asset retention: cutoff=.* (override) builds kept=2 dropped=1 inherited files kept=2 removed=1 unlisted=1 missing=1' \
  "${TMP_ROOT}/retention.log"; then
  cat "${TMP_ROOT}/retention.log" >&2
  echo "retention did not log what it kept and dropped" >&2
  exit 1
fi
node - "$RET_STATIC" "${RET_TARGET}/runtime/control-plane/frontend-asset-ledger.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [root, ledgerPath] = process.argv.slice(2);
const history = JSON.parse(fs.readFileSync(path.join(root, "frontend-build-history.json"), "utf8"));
if (history.builds.length !== 2) throw new Error("history must keep its two-build shape");
if (history.retention?.source !== "override" || history.retention.required_browser_version !== null) {
  throw new Error(`unexpected retention record: ${JSON.stringify(history.retention)}`);
}
const retained = history.builds[1].assets.join(",");
if (retained !== "mid-2222222222222222.js,previous-1111111111111111.js") {
  throw new Error(`unexpected retained assets: ${retained}`);
}
const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
const names = ledger.builds.map((build) => build.fingerprint).join(",");
if (names !== "current,previous,mid") throw new Error(`unexpected ledger builds: ${names}`);
NODE

# A previous release without a ledger: its build and every chunk it carried
# age together, kept while it is within the cutoff, removed once it is not.
rm -f "${RET_PREVIOUS}/runtime/control-plane/frontend-asset-ledger.json"
preserve_previous_static_assets
prepare_frontend_asset_history >"${TMP_ROOT}/retention-legacy.log"
grep -q 'builds kept=1 dropped=0' "${TMP_ROOT}/retention-legacy.log"
[[ -f "${RET_STATIC}/unlisted-5555555555555555.js" ]]
export FRONTEND_ASSET_RETENTION_CUTOFF_MS="$((NOW_MS - DAY_MS))"
prepare_frontend_asset_history >"${TMP_ROOT}/retention-legacy-old.log"
grep -q 'builds kept=0 dropped=1' "${TMP_ROOT}/retention-legacy-old.log"
for asset in previous-1111111111111111.js mid-2222222222222222.js unlisted-5555555555555555.js; do
  if [[ -e "${RET_STATIC}/${asset}" ]]; then
    echo "an aged-out legacy chunk was kept: ${asset}" >&2
    exit 1
  fi
done
for asset in current-7777777777777777.js shared-4444444444444444.js; do
  if [[ ! -f "${RET_STATIC}/${asset}" ]]; then
    echo "the current build lost ${asset}" >&2
    exit 1
  fi
done
node - "$RET_STATIC" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const history = JSON.parse(fs.readFileSync(path.join(process.argv[2], "frontend-build-history.json"), "utf8"));
if (history.builds.length !== 1) throw new Error("only the current build should remain");
NODE
unset FRONTEND_ASSET_RETENTION_CUTOFF_MS

# Reading the setting as the hub enforces it: the smaller of the required and
# recommended versions, nothing when either is unset or unusable.
mkdir -p "${BAY_ROOT}/run/postgres"
PSQL_BIN=/bin/false
SETTINGS_ROWS=""
runuser() { printf '%s' "$SETTINGS_ROWS"; }
SETTINGS_ROWS=$'version_min_browser 1792710260\nversion_recommended_browser 1792800000\n'
[[ "$(read_required_browser_version)" == 1792710260 ]]
SETTINGS_ROWS=$'version_min_browser 1792710260\nversion_recommended_browser 1792000000\n'
[[ "$(read_required_browser_version)" == 1792000000 ]]
SETTINGS_ROWS=$'version_min_browser 1792710260\n'
[[ -z "$(read_required_browser_version)" ]]
SETTINGS_ROWS=$'version_min_browser oct-22\nversion_recommended_browser 1792800000\n'
[[ -z "$(read_required_browser_version)" ]]
SETTINGS_ROWS=$'version_min_browser 0\nversion_recommended_browser 1792800000\n'
[[ -z "$(read_required_browser_version)" ]]
runuser() { return 2; }
[[ -z "$(read_required_browser_version)" ]]
unset -f runuser
PSQL_BIN=""

# The cutoff: the required browser version less a day of slack, or a fixed
# window when the setting cannot be read; never everything.
read_required_browser_version() { echo 1792710260; }
[[ "$(frontend_asset_retention_cutoff)" == "$((1792710260000 - 86400000)) required-browser-version=1792710260" ]]
read_required_browser_version() { :; }
cutoff="$(frontend_asset_retention_cutoff)"
[[ "${cutoff#* }" == "fallback-14d" ]]
expected=$((($(date +%s) - 14 * 86400) * 1000))
if ((${cutoff%% *} > expected || ${cutoff%% *} < expected - 5000)); then
  echo "fallback cutoff is not 14 days ago: ${cutoff}" >&2
  exit 1
fi
[[ "$(FRONTEND_ASSET_RETENTION_CUTOFF_MS=123 frontend_asset_retention_cutoff)" == "123 override" ]]

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
# evaluates) and the release runner its health check uses, also from a
# trusted copy of its bundle, and refuses a bundle without the runner.
static_root="${TMP_ROOT}/static-bundle/cocalc-bay-static-test"
mkdir -p "${static_root}/scripts/bay-systemd/needrestart"
printf '# trusted policy\n' > "${static_root}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
tar -czf "${TMP_ROOT}/static-bundle.tar.gz" -C "${TMP_ROOT}/static-bundle" cocalc-bay-static-test
STATIC_BUNDLE_PATH="${TMP_ROOT}/static-bundle.tar.gz"
if (stage_trusted_scaffold static >/dev/null 2>&1); then
  echo "static scaffold staged without cocalc-bay-run" >&2
  exit 1
fi
rm -rf "${TMP_ROOT}"/cocalc-bay-scaffold.*
mkdir -p "${static_root}/scripts/bay-systemd/sbin"
printf '#!/usr/bin/env bash\n# trusted runner\n' > "${static_root}/scripts/bay-systemd/sbin/cocalc-bay-run"
tar -czf "${TMP_ROOT}/static-bundle.tar.gz" -C "${TMP_ROOT}/static-bundle" cocalc-bay-static-test
mkdir -p "${TARGET_RELEASE}/scripts/bay-systemd/needrestart"
printf 'system("touch /tmp/pwned");\n' > "${TARGET_RELEASE}/scripts/bay-systemd/needrestart/cocalc-bay.conf"
STATIC_BUNDLE_PATH="${TMP_ROOT}/static-bundle.tar.gz"
SOURCE_ROOT=""
NEEDRESTART_POLICY_PATH="${TMP_ROOT}/installed-needrestart.conf"
BAY_RUN_PATH="${TMP_ROOT}/sbin/cocalc-bay-run"
stage_trusted_scaffold static >/dev/null
install_needrestart_policy >/dev/null
install_bay_runner >/dev/null
remove_trusted_scaffold
[[ "$(cat "$NEEDRESTART_POLICY_PATH")" == "# trusted policy" ]] ||
  { echo "needrestart policy did not come from the bundle" >&2; exit 1; }
[[ -x "$BAY_RUN_PATH" ]] && grep -q '# trusted runner' "$BAY_RUN_PATH" ||
  { echo "cocalc-bay-run was not installed from the static bundle" >&2; exit 1; }
if ! awk '/stage_trusted_scaffold static/ { staged = 1 }
    staged && /install_bay_runner/ { installed = 1 }
    installed && /set_current_release/ { found = 1; exit }
    END { exit !found }' "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "a static deploy does not install cocalc-bay-run before switching releases" >&2
  exit 1
fi
STATIC_BUNDLE_PATH=""
# Root changes ownership in the bay-owned trees only with protected_hardlinks.
for value in 0 2 ""; do
  printf '%s\n' "$value" > "${TMP_ROOT}/protected_hardlinks"
  if (PROTECTED_HARDLINKS_PATH="${TMP_ROOT}/protected_hardlinks" require_protected_hardlinks 2>/dev/null); then
    echo "deploy allowed with protected_hardlinks=${value}" >&2
    exit 1
  fi
done
if (PROTECTED_HARDLINKS_PATH="${TMP_ROOT}/missing" require_protected_hardlinks 2>/dev/null); then
  echo "deploy allowed with protected_hardlinks unreadable" >&2
  exit 1
fi
printf '1\n' > "${TMP_ROOT}/protected_hardlinks"
PROTECTED_HARDLINKS_PATH="${TMP_ROOT}/protected_hardlinks" require_protected_hardlinks
bay_chown='^ *run chown -R "\$\{BAY_USER\}'
if [[ "$(grep -cE "$bay_chown" "${SCRIPT_DIR}/bay-bootstrap-release.sh")" != \
  "$(grep -B1 -E "$bay_chown" "${SCRIPT_DIR}/bay-bootstrap-release.sh" | grep -c '^ *require_protected_hardlinks$')" ]]; then
  echo "a recursive root chown is not preceded by require_protected_hardlinks" >&2
  exit 1
fi
# Nothing root reads into /etc (overlay env, needrestart) comes from the
# release, and the CDN preservation runs its code and copies as the bay user.
if grep -nE '(cat|<) "\$\{TARGET_RELEASE\}' "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "root reads configuration from the release directory" >&2
  exit 1
fi
# Root never mutates, follows or executes inside the bay-owned release and
# state trees: every such command there runs as the bay account.
if grep -nE '^\s*(run )?(rm|mkdir|cp|rsync|ln|tar|install|mv|touch|cat|printf .*>|"\$node_bin") .*\$\{?(TARGET_RELEASE|RELEASES_DIR|CURRENT_LINK|BAY_ROOT|extract_dir|target_|previous_|postgres_)' \
  "${SCRIPT_DIR}/bay-bootstrap-release.sh" | grep -v 'as_bay'; then
  echo "root works directly inside a bay-owned tree (use as_bay)" >&2
  exit 1
fi
if grep -nE '> *"?\$\{?(BAY_ROOT|TARGET_RELEASE|CURRENT_LINK|RELEASES_DIR)' "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "root redirects output into a bay-owned tree" >&2
  exit 1
fi
if grep -n 'INSTALL_CMD.*TARGET_RELEASE\|"\${TARGET_RELEASE}/scripts/bay-systemd/install-scaffold.sh"$' \
  "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "an installer still runs from the release directory" >&2
  exit 1
fi

# upgrade-bay-release.sh: root runs release commands only through the root
# runner (as the bay account), migrations only with runuser, and writes the
# release only as the bay account.
UPGRADE="${SCRIPT_DIR}/upgrade-bay-release.sh"
if grep -n '/opt/cocalc/bay/current/bin/' "$UPGRADE" | grep -v '/opt/cocalc/bay/current/bin/bay-migrate$'; then
  echo "upgrade-bay-release.sh runs release code as root" >&2
  exit 1
fi
if [[ "$(grep -c '^  /opt/cocalc/bay/current/bin/bay-migrate$' "$UPGRADE")" != \
  "$(grep -c '^runuser -u "\$BAY_USER" -- env \\$' "$UPGRADE")" ]]; then
  echo "a migration is not run with runuser" >&2
  exit 1
fi
if grep -nE '^(rm|mkdir|rsync|cp|chown|tar) .*\\\$current' "$UPGRADE"; then
  echo "upgrade-bay-release.sh writes the release as root" >&2
  exit 1
fi

# cocalc-bay-run: a validated bay command, as the bay user, with the bay
# environment.
cat > "${TMP_ROOT}/fake-systemd-run" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" > "${FAKE_SYSTEMD_RUN_LOG}"
EOF
chmod 0755 "${TMP_ROOT}/fake-systemd-run"
export FAKE_SYSTEMD_RUN_LOG="${TMP_ROOT}/systemd-run.log"
SYSTEMD_RUN="${TMP_ROOT}/fake-systemd-run" bash "${SCRIPT_DIR}/sbin/cocalc-bay-run" bay-health --verbose
grep -qx 'User=cocalc-bay' "$FAKE_SYSTEMD_RUN_LOG" || { echo "cocalc-bay-run not as the bay user" >&2; exit 1; }
grep -qx 'EnvironmentFile=-/etc/cocalc/bay-secrets.env' "$FAKE_SYSTEMD_RUN_LOG" ||
  { echo "cocalc-bay-run without the bay environment" >&2; exit 1; }
grep -qx '/opt/cocalc/bay/current/bin/bay-health' "$FAKE_SYSTEMD_RUN_LOG" ||
  { echo "cocalc-bay-run ran the wrong program" >&2; exit 1; }
for bad in ../bay-health /bin/sh 'bay-health;id' sh; do
  if SYSTEMD_RUN="${TMP_ROOT}/fake-systemd-run" bash "${SCRIPT_DIR}/sbin/cocalc-bay-run" "$bad" 2>/dev/null; then
    echo "cocalc-bay-run accepted $bad" >&2
    exit 1
  fi
done

# A bay fenced for a restore takes no deploy: only a rebuild's install with
# --fenced, and never --start.
fence_check() {
  (RESTORE_FENCE="${TMP_ROOT}/bay-restore-fence" ALLOW_FENCED="$1" START_BAY="$2" check_restore_fence) 2>/dev/null
}
fence_check 0 1 || { echo "refused a deploy to a bay that is not fenced" >&2; exit 1; }
if fence_check 1 1; then
  echo "accepted --fenced with --start" >&2
  exit 1
fi
touch "${TMP_ROOT}/bay-restore-fence"
if fence_check 0 0; then
  echo "deployed to a fenced bay" >&2
  exit 1
fi
if fence_check 1 1; then
  echo "started a fenced bay" >&2
  exit 1
fi
fence_check 1 0 || { echo "refused a rebuild's --fenced install" >&2; exit 1; }
# Before anything is staged: the check comes first in main, after root.
if ! awk '/^main\(\)/ { inmain = 1 } inmain && /require_root$/ { getline; found = $1 == "check_restore_fence"; exit } END { exit !found }' \
  "${SCRIPT_DIR}/bay-bootstrap-release.sh"; then
  echo "check_restore_fence is not the first step after require_root" >&2
  exit 1
fi

# As root the whole run holds the deploy lock, so it is refused, before it
# parses anything, while a restore holds it (needs passwordless sudo).
if [[ "$(id -u)" == 0 ]] || sudo -n true 2>/dev/null; then
  lock="${TMP_ROOT}/deploy.lock"
  flock -o "$lock" sleep 30 &
  holder=$!
  sleep 0.5
  if sudo -n env COCALC_BAY_DEPLOY_LOCK="$lock" "${SCRIPT_DIR}/bay-bootstrap-release.sh" --help \
    > "${TMP_ROOT}/locked.out" 2>&1; then
    echo "ran while a restore held the deploy lock" >&2
    exit 1
  fi
  grep -q 'a bay restore or another deploy is running' "${TMP_ROOT}/locked.out" ||
    { echo "no lock refusal: $(cat "${TMP_ROOT}/locked.out")" >&2; exit 1; }
  kill "$holder" 2>/dev/null || true
  wait "$holder" 2>/dev/null || true
  sudo -n env COCALC_BAY_DEPLOY_LOCK="$lock" "${SCRIPT_DIR}/bay-bootstrap-release.sh" --help >/dev/null ||
    { echo "refused once the lock was free" >&2; exit 1; }
else
  echo "note: deploy lock test needs root or passwordless sudo; skipped" >&2
fi

echo "bay release pruning and CDN retention tests passed"
