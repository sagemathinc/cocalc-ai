/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Space } from "antd";
import { useMemo, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";

interface WizardProps {
  open: boolean;
  onClose: () => void;
  onApply: (values: Record<string, string>) => Promise<void> | void;
}

type ParsedValues = {
  nebius_credentials_json: string;
  nebius_parent_id: string;
  nebius_subnet_id: string;
  project_hosts_nebius_prefix?: string;
};

const START_MARKER = "=== COCALC NEBIUS CONFIG START ===";
const END_MARKER = "=== COCALC NEBIUS CONFIG END ===";

function normalizeParsed(obj: any): ParsedValues | null {
  if (!obj || typeof obj !== "object") return null;
  const credsRaw =
    obj.nebius_credentials_json ??
    obj.credentials_json ??
    obj.credentials ??
    obj.nebius_credentials;
  const parent =
    obj.nebius_parent_id ?? obj.parent_id ?? obj.project_id ?? obj.project;
  const subnet = obj.nebius_subnet_id ?? obj.subnet_id ?? obj.subnet;
  const prefix = obj.project_hosts_nebius_prefix ?? obj.nebius_prefix;
  if (!credsRaw || !parent || !subnet) return null;
  const creds =
    typeof credsRaw === "string" ? credsRaw : JSON.stringify(credsRaw, null, 2);
  return {
    nebius_credentials_json: creds,
    nebius_parent_id: `${parent}`.trim(),
    nebius_subnet_id: `${subnet}`.trim(),
    project_hosts_nebius_prefix:
      prefix == null ? undefined : `${prefix}`.trim(),
  };
}

function extractJsonBlock(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }
  const markerMatch = trimmed.match(
    new RegExp(
      `${START_MARKER}([\\s\\S]*?)${END_MARKER}`,
      "m",
    ),
  );
  if (markerMatch?.[1]) {
    try {
      return JSON.parse(markerMatch[1].trim());
    } catch {
      // ignore
    }
  }
  const candidates = trimmed.match(/\{[\s\S]*\}/g);
  if (!candidates) return null;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(candidates[i]);
    } catch {
      // keep trying
    }
  }
  return null;
}

export default function NebiusCliWizard({
  open,
  onClose,
  onApply,
}: WizardProps) {
  const [output, setOutput] = useState("");
  const [parsed, setParsed] = useState<ParsedValues | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const scriptMarkdown = useMemo(
    () => `Run this once in your terminal (after installing and authenticating \`nebius\`):

\`\`\`sh
set -euo pipefail

NEBIUS_SA_NAME="\${NEBIUS_SA_NAME:-cocalc-launchpad}"
NEBIUS_PREFIX="\${NEBIUS_PREFIX:-cocalc-host}"

log() {
  echo ""
  echo "==> $*"
}

find_sa_id() {
  local parent="$1"
  local sa_id
  sa_id=$(nebius iam service-account get-by-name \
    --parent-id "$parent" \
    --name "$NEBIUS_SA_NAME" \
    --format jsonpath='{.metadata.id}' 2>/dev/null || true)
  if [ -n "$sa_id" ]; then
    echo "$sa_id"
    return
  fi
  local sa_list
  sa_list=$(nebius iam service-account list \
    --parent-id "$parent" \
    --page-size 200 \
    --format json 2>/dev/null || true)
  if [ -n "$sa_list" ]; then
    python3 - <<'PY'
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(0)
data = json.loads(raw)
def find(obj):
  if isinstance(obj, dict):
    meta = obj.get("metadata")
    if isinstance(meta, dict) and meta.get("name") == "\${NEBIUS_SA_NAME}":
      print(meta.get("id") or "")
      return True
    for v in obj.values():
      if find(v):
        return True
  elif isinstance(obj, list):
    for v in obj:
      if find(v):
        return True
  return False
find(data)
PY
    <<<"$sa_list" || true
  fi
}

pick_id() {
  local label="$1"
  local json="$2"
  local tmp
  tmp=$(mktemp)
  printf "%s" "$json" > "$tmp"
  local list
  list=$(python3 - "$label" "$tmp" <<'PY'
import json, sys
label = sys.argv[1]
path = sys.argv[2]
data = json.load(open(path))
items = []
def visit(obj):
  if isinstance(obj, dict):
    meta = obj.get("metadata")
    if isinstance(meta, dict):
      mid = meta.get("id")
      name = meta.get("name") or ""
      if mid:
        items.append((mid, name))
    for v in obj.values():
      visit(v)
  elif isinstance(obj, list):
    for v in obj:
      visit(v)
visit(data)
seen = set()
for mid, name in items:
  if mid in seen:
    continue
  seen.add(mid)
  print(f"{mid}\\t{name}")
PY
  )
  rm -f "$tmp"
  if [ -z "$list" ]; then
    echo "No $label found. Please create one in the Nebius console." >&2
    exit 1
  fi
  local count
  count=$(echo "$list" | grep -c . || true)
  if [ "$count" -eq 1 ]; then
    echo "$list" | cut -f1
    return
  fi
  echo "Select $label:" >&2
  nl -w2 -s") " <(echo "$list" | sed $'s/\\t/  /') >&2
  read -r -p "Enter number: " idx
  echo "$list" | sed -n "\${idx}p" | cut -f1
}

TENANT_JSON=$(nebius iam tenant list --format json --page-size 100)
TENANT_ID=$(pick_id "tenant" "$TENANT_JSON")

log "Selected tenant: $TENANT_ID"

PROJECT_JSON=$(nebius iam project list --format json --page-size 100 --parent-id "$TENANT_ID")
PROJECT_ID=$(pick_id "project" "$PROJECT_JSON")

log "Selected project: $PROJECT_ID"

log "Ensuring service account '$NEBIUS_SA_NAME' exists..."
CREATE_ERR=$(mktemp)
nebius iam service-account create \
  --parent-id "$PROJECT_ID" \
  --name "$NEBIUS_SA_NAME" \
  --async true \
  --format json >/dev/null 2>"$CREATE_ERR" || true

if [ -s "$CREATE_ERR" ]; then
  echo "Warning: service-account create returned a message (often means it already exists):" >&2
  sed -n '1,120p' "$CREATE_ERR" >&2
fi
rm -f "$CREATE_ERR"

SA_ID=""
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if [ "$attempt" -eq 1 ]; then
    log "Waiting for service account lookup..."
  fi
  SA_ID=$(find_sa_id "$PROJECT_ID")
  if [ -z "$SA_ID" ]; then
    SA_ID=$(find_sa_id "$TENANT_ID")
  fi
  if [ -n "$SA_ID" ]; then
    break
  fi
  sleep 3
done

if [ -z "$SA_ID" ]; then
  echo "Failed to create or lookup service account '$NEBIUS_SA_NAME'." >&2
  echo "Tip: verify you can create service accounts in the selected project and that the name is correct." >&2
  exit 1
fi

log "Service account: $SA_ID"

EDITORS_GROUP_ID=$(nebius iam group get-by-name \
  --name editors \
  --parent-id "$TENANT_ID" \
  --format jsonpath='{.metadata.id}' 2>/dev/null || true)

if [ -z "$EDITORS_GROUP_ID" ]; then
  echo "Failed to lookup editors group for tenant $TENANT_ID." >&2
  exit 1
fi

nebius iam group-membership create \
  --parent-id "$EDITORS_GROUP_ID" \
  --member-id "$SA_ID" >/dev/null || true

CREDS_PATH=$(mktemp)
log "Generating service account credentials..."
nebius iam auth-public-key generate \
  --parent-id "$PROJECT_ID" \
  --service-account-id "$SA_ID" \
  --output "$CREDS_PATH"

SUBNET_JSON=$(nebius vpc subnet list --format json --page-size 100 --parent-id "$PROJECT_ID")
SUBNET_ID=$(pick_id "subnet" "$SUBNET_JSON")

log "Selected subnet: $SUBNET_ID"

export CREDS_PATH PROJECT_ID SUBNET_ID NEBIUS_PREFIX

python3 - <<'PY'
import json, os
creds_path = os.environ["CREDS_PATH"]
creds = open(creds_path, "r", encoding="utf-8").read()
out = {
  "nebius_credentials_json": creds,
  "nebius_parent_id": os.environ["PROJECT_ID"],
  "nebius_subnet_id": os.environ["SUBNET_ID"],
  "project_hosts_nebius_prefix": os.environ["NEBIUS_PREFIX"],
}
print("${START_MARKER}")
print(json.dumps(out, indent=2))
print("${END_MARKER}")
PY
\`\`\`
`,
    [],
  );

  function parseOutput(text: string) {
    setOutput(text);
    setNotice("");
    const raw = extractJsonBlock(text);
    const normalized = normalizeParsed(raw);
    if (!raw || !normalized) {
      setParsed(null);
      if (text.trim().length > 0) {
        setParseError("Could not find a valid Nebius config JSON block.");
      } else {
        setParseError(null);
      }
      return;
    }
    setParseError(null);
    setParsed(normalized);
  }

  async function applySettings() {
    if (!parsed) return;
    const updates: Record<string, string> = {
      nebius_credentials_json: parsed.nebius_credentials_json,
      nebius_parent_id: parsed.nebius_parent_id,
      nebius_subnet_id: parsed.nebius_subnet_id,
    };
    if (parsed.project_hosts_nebius_prefix) {
      updates.project_hosts_nebius_prefix = parsed.project_hosts_nebius_prefix;
    }
    await onApply(updates);
    setNotice("Settings applied and saved.");
    onClose();
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onClose}
      okText="Close"
      title="Nebius Configuration Wizard"
      width={920}
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Configure Nebius CLI credentials in one pass."
          description="This wizard generates credentials via the Nebius CLI and fills in all required settings."
        />
        <div>
          <strong>Step 1 - Install and authenticate the Nebius CLI</strong>
          <div style={{ marginTop: "6px", color: "#666" }}>
            <StaticMarkdown
              value={`Install and authenticate the Nebius CLI from https://docs.nebius.com/cli/install`}
            />
          </div>
        </div>
        <div>
          <strong>Step 2 - Run this script</strong>
          <StaticMarkdown value={scriptMarkdown} />
        </div>
        <div>
          <strong>Step 3 - Paste the output</strong>
          <Input.TextArea
            rows={8}
            placeholder="Paste the script output here..."
            value={output}
            onChange={(e) => parseOutput(e.target.value)}
          />
          {parseError ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: "8px" }}
              message={parseError}
            />
          ) : null}
          {parsed ? (
            <Alert
              type="success"
              showIcon
              style={{ marginTop: "8px" }}
              message="Parsed Nebius configuration."
              description={
                <div>
                  <div>
                    <b>Project (parent) ID:</b> {parsed.nebius_parent_id}
                  </div>
                  <div>
                    <b>Subnet ID:</b> {parsed.nebius_subnet_id}
                  </div>
                  <div>
                    <b>Prefix:</b>{" "}
                    {parsed.project_hosts_nebius_prefix ?? "cocalc-host"}
                  </div>
                  <div>
                    <b>Credentials:</b> detected
                  </div>
                </div>
              }
            />
          ) : null}
        </div>
        <Button
          type="primary"
          icon={<Icon name="save" />}
          onClick={applySettings}
          disabled={!parsed}
        >
          Apply Settings
        </Button>
        {notice ? <Alert type="success" showIcon message={notice} /> : null}
      </Space>
    </Modal>
  );
}
