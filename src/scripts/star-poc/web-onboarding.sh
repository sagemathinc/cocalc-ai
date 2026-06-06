#!/usr/bin/env bash

# Shared helpers for CoCalc Star public VM web onboarding.
#
# The onboarding page is intentionally static. Caddy serves
# /star-install/<nonce>/ from STAR_ROOT/web-onboarding, and the installer updates
# status.json atomically while the page polls it.

star_web_onboarding_enabled() {
  case "${STAR_WEB_ONBOARDING:-auto}" in
    0 | false | no | off) return 1 ;;
    1 | true | yes | on) [ -n "${STAR_PUBLIC_URL:-}" ] ;;
    auto | "") [ -n "${STAR_PUBLIC_URL:-}" ] ;;
    *)
      printf '[star-web-onboarding] invalid STAR_WEB_ONBOARDING=%s\n' "${STAR_WEB_ONBOARDING}" >&2
      return 1
      ;;
  esac
}

star_web_onboarding_root() {
  printf '%s\n' "${STAR_WEB_ONBOARDING_ROOT:-${STAR_ROOT:-/var/lib/cocalc/star}/web-onboarding}"
}

star_web_onboarding_env_file() {
  printf '%s\n' "${STAR_WEB_ONBOARDING_ENV:-/etc/cocalc/star/web-onboarding.env}"
}

star_web_onboarding_load_env() {
  local env_file
  env_file="$(star_web_onboarding_env_file)"
  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    source "$env_file"
  fi
}

star_web_onboarding_nonce() {
  star_web_onboarding_load_env
  if [ -n "${STAR_WEB_ONBOARDING_NONCE:-}" ]; then
    printf '%s\n' "$STAR_WEB_ONBOARDING_NONCE"
    return
  fi

  STAR_WEB_ONBOARDING_NONCE="$(
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 24
    else
      date -u +%s%N | sha256sum | awk '{print $1}'
    fi
  )"
  export STAR_WEB_ONBOARDING_NONCE

  local env_file tmp
  env_file="$(star_web_onboarding_env_file)"
  tmp="$(mktemp)"
  mkdir -p "$(dirname "$env_file")"
  printf 'STAR_WEB_ONBOARDING_NONCE=%q\n' "$STAR_WEB_ONBOARDING_NONCE" >"$tmp"
  if [ "$(id -u)" -eq 0 ]; then
    install -m 0600 -o root -g root "$tmp" "$env_file"
  else
    install -m 0600 "$tmp" "$env_file"
  fi
  rm -f "$tmp"
  printf '%s\n' "$STAR_WEB_ONBOARDING_NONCE"
}

star_web_onboarding_dir() {
  local nonce
  nonce="$(star_web_onboarding_nonce)"
  printf '%s/%s\n' "$(star_web_onboarding_root)" "$nonce"
}

star_web_onboarding_url() {
  local nonce
  nonce="$(star_web_onboarding_nonce)"
  printf '%s/star-install/%s/\n' "${STAR_PUBLIC_URL%/}" "$nonce"
}

star_web_onboarding_public_host() {
  local value="${STAR_PUBLIC_URL:-}"
  value="${value#*://}"
  value="${value%%/*}"
  value="${value%%:*}"
  printf '%s\n' "$value"
}

star_web_onboarding_site_address() {
  local host
  host="$(star_web_onboarding_public_host)"
  if [ -n "$host" ]; then
    printf '%s\n' "$host"
  else
    printf ':80\n'
  fi
}

star_web_onboarding_port() {
  printf '%s\n' "${STAR_WEB_ONBOARDING_PORT:-9199}"
}

star_web_onboarding_pid_file() {
  printf '%s\n' "$(star_web_onboarding_root)/server.pid"
}

star_web_onboarding_open_marker() {
  printf '%s\n' "$(star_web_onboarding_dir)/opened"
}

star_web_onboarding_require_open() {
  case "${STAR_WEB_ONBOARDING_REQUIRE_OPEN:-auto}" in
    1 | true | yes | on) return 0 ;;
    0 | false | no | off) return 1 ;;
    auto | "")
      [ "${STAR_ASSUME_YES:-0}" != "1" ] && [ -t 0 ]
      ;;
    *)
      printf '[star-web-onboarding] invalid STAR_WEB_ONBOARDING_REQUIRE_OPEN=%s\n' "${STAR_WEB_ONBOARDING_REQUIRE_OPEN}" >&2
      return 1
      ;;
  esac
}

star_web_onboarding_json_string_field() {
  local file="$1"
  local field="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg field "$field" '.[$field] // empty' "$file"
    return
  fi
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" "$file" | head -1
}

star_web_onboarding_url_with_base() {
  local url="$1"
  local base="$2"
  local path
  base="${base%/}"
  case "$url" in
    *://*/*)
      path="/${url#*://*/}"
      ;;
    *://*)
      path="/"
      ;;
    /*)
      path="$url"
      ;;
    *)
      path="/"
      ;;
  esac
  printf '%s%s' "$base" "$path"
}

star_web_onboarding_write_index() {
  local dir="$1"
  cat >"${dir}/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CoCalc Star Installer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe6;
      --ink: #162019;
      --muted: #667064;
      --card: #fffaf1;
      --line: #d6c8ad;
      --accent: #1f6f57;
      --accent-2: #b9552b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-serif, Georgia, Cambria, "Times New Roman", serif;
      color: var(--ink);
      background: var(--bg);
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    main {
      width: min(44rem, 100%);
      background: color-mix(in srgb, var(--card) 94%, white);
      border: 1px solid var(--line);
      box-shadow: 0 2rem 5rem rgba(38, 31, 18, 0.16);
      border-radius: 1.25rem;
      padding: clamp(1.5rem, 4vw, 3rem);
    }
    h1 {
      font-size: clamp(2.2rem, 8vw, 4.8rem);
      line-height: 0.9;
      margin: 0 0 1rem;
      letter-spacing: -0.06em;
    }
    p { font-size: 1.08rem; line-height: 1.55; }
    .eyebrow {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--accent-2);
      font-size: 0.82rem;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      margin-bottom: 1rem;
    }
    .status {
      margin: 2rem 0;
      padding: 1.1rem 1.2rem;
      border: 1px solid var(--line);
      border-radius: 0.9rem;
      background: rgba(255, 255, 255, 0.48);
    }
    .phase {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 0.55rem;
    }
    .message { color: var(--muted); margin: 0; }
    ul {
      margin: 1.25rem 0 0;
      padding-left: 1.25rem;
      color: var(--muted);
      line-height: 1.5;
    }
    .estimate {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--accent-2);
      margin-top: 1rem;
    }
    a.button, button.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: 0.85rem 1rem;
      border-radius: 0.75rem;
      color: white;
      background: var(--accent);
      text-decoration: none;
      font-weight: 700;
      border: 0;
      cursor: pointer;
      font: inherit;
    }
    button.button:disabled {
      cursor: default;
      opacity: 0.68;
    }
    #start {
      margin-top: 0.8rem;
    }
    #actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-top: 0.85rem;
    }
    .progress-wrap {
      margin-top: 1.25rem;
      height: 0.75rem;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.62);
    }
    .progress {
      width: 5%;
      height: 100%;
      background: var(--accent);
      transition: width 400ms ease;
    }
    .meta {
      margin-top: 2rem;
      color: var(--muted);
      font-size: 0.93rem;
      border-top: 1px solid var(--line);
      padding-top: 1rem;
    }
    .timing {
      margin-top: 0.85rem;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9rem;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      background: rgba(31, 111, 87, 0.08);
      padding: 0.1rem 0.3rem;
      border-radius: 0.3rem;
    }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">CoCalc Star public VM setup</div>
    <h1>Your server is reachable.</h1>
    <p>This installer will configure a single-VM CoCalc Star server on this machine.</p>
    <ul>
      <li>Install required Ubuntu packages and system services.</li>
      <li>Configure Caddy with automatic HTTPS for this public URL.</li>
      <li>Create local PostgreSQL and CoCalc Star runtime state.</li>
      <li>Prepare the default Jupyter, terminal, and LaTeX project image.</li>
      <li>Start CoCalc and show the first-admin account link.</li>
    </ul>
    <p class="estimate">Estimated time: about 10 minutes.</p>
    <button class="button" id="start">Start install</button>
    <section class="status" aria-live="polite">
      <div class="phase" id="phase">starting</div>
      <p class="message" id="message">Waiting for installer status...</p>
      <div class="timing" id="timing">Install has not started yet.</div>
      <div id="actions"></div>
      <div class="progress-wrap" aria-label="Install progress">
        <div class="progress" id="progress"></div>
      </div>
    </section>
    <p class="meta">This page is protected by a one-time path token. It is not a backup or admin console; it only shows this install status and final bootstrap link.</p>
  </main>
  <script>
    const phase = document.getElementById("phase");
    const message = document.getElementById("message");
    const actions = document.getElementById("actions");
    const progress = document.getElementById("progress");
    const start = document.getElementById("start");
    const timing = document.getElementById("timing");

    const progressByPhase = {
      starting: 5,
      reachable: 10,
      runtime: 25,
      rootfs: 65,
      systemd: 82,
      "starting-services": 92,
      ready: 100,
      failed: 100,
    };

    function addAction(url, label) {
      if (!url) return;
      const link = document.createElement("a");
      link.className = "button";
      link.href = url;
      link.textContent = label;
      actions.appendChild(link);
    }

    function setActions(status) {
      actions.innerHTML = "";
      addAction(status.bootstrap_url, "Create the first admin account");
      addAction(status.invite_url, "Invite another user");
    }

    function setProgress(name) {
      progress.style.width = (progressByPhase[name] || 12) + "%";
    }

    function parseDate(value) {
      if (!value) return;
      const date = new Date(value);
      if (Number.isNaN(date.valueOf())) return;
      return date;
    }

    function formatElapsed(ms) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      if (minutes === 0) return seconds + "s";
      return minutes + "m " + String(seconds).padStart(2, "0") + "s";
    }

    function setTiming(status) {
      const started = parseDate(status.started_at);
      if (!started) {
        timing.textContent = "Install has not started yet.";
        return;
      }
      const startedLabel = started.toLocaleString([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
      timing.textContent =
        "Started at " +
        startedLabel +
        " · elapsed " +
        formatElapsed(Date.now() - started.getTime());
    }

    async function continueInstall() {
      start.disabled = true;
      start.textContent = "Starting install...";
      try {
        const response = await fetch("continue", { method: "POST", cache: "no-store" });
        if (!response.ok) throw new Error(response.statusText);
        start.textContent = "Install started";
      } catch (err) {
        start.disabled = false;
        start.textContent = "Start install";
        message.textContent = "Could not notify the installer. Refresh this page and try again.";
      }
    }

    async function poll() {
      try {
        const response = await fetch("status.json?ts=" + Date.now(), { cache: "no-store" });
        if (!response.ok) throw new Error(response.statusText);
        const status = await response.json();
        const name = status.phase || "installing";
        phase.textContent = name;
        message.textContent = status.message || "Installing CoCalc Star...";
        setTiming(status);
        setProgress(name);
        if (["runtime", "rootfs", "systemd", "starting-services", "ready"].includes(name)) {
          start.disabled = true;
          start.textContent = name === "ready" ? "Install complete" : "Install started";
        }
        setActions(status);
      } catch (err) {
        phase.textContent = "waiting";
        message.textContent = "Waiting for the installer to write status...";
        setTiming({});
        setProgress("starting");
        setActions({});
      }
    }

    start.addEventListener("click", continueInstall);
    poll();
    setInterval(poll, 2000);
  </script>
</body>
</html>
HTML
}

star_web_onboarding_prepare() {
  star_web_onboarding_enabled || return 0
  local dir
  dir="$(star_web_onboarding_dir)"
  mkdir -p "$dir"
  chmod 0755 "$(star_web_onboarding_root)" "$dir"
  star_web_onboarding_write_index "$dir"
  star_web_onboarding_write_status "starting" "The public HTTPS onboarding page is online. The CoCalc Star install is starting." ""
}

star_web_onboarding_write_status() {
  star_web_onboarding_enabled || return 0
  local phase="${1:-installing}"
  local message="${2:-Installing CoCalc Star...}"
  local bootstrap_url="${3:-}"
  local invite_url="${4:-}"
  local dir status tmp
  dir="$(star_web_onboarding_dir)"
  mkdir -p "$dir"
  status="${dir}/status.json"
  tmp="$(mktemp "${status}.XXXXXX")"
  PHASE="$phase" \
    MESSAGE="$message" \
    PUBLIC_URL="${STAR_PUBLIC_URL:-}" \
    BOOTSTRAP_URL="$bootstrap_url" \
    INVITE_URL="$invite_url" \
    UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    STATUS_PATH="$status" \
    python3 - "$tmp" <<'PY'
import json
import os
import sys

path = sys.argv[1]
status_path = os.environ.get("STATUS_PATH", "")
started_at = ""
if status_path:
    try:
        with open(status_path, "r", encoding="utf-8") as f:
            existing = json.load(f)
        started_at = existing.get("started_at", "")
    except Exception:
        started_at = ""
if not started_at:
    started_at = os.environ.get("UPDATED_AT", "")
payload = {
    "phase": os.environ.get("PHASE", "installing"),
    "message": os.environ.get("MESSAGE", ""),
    "public_url": os.environ.get("PUBLIC_URL", ""),
    "bootstrap_url": os.environ.get("BOOTSTRAP_URL", ""),
    "invite_url": os.environ.get("INVITE_URL", ""),
    "started_at": started_at,
    "updated_at": os.environ.get("UPDATED_AT", ""),
}
with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  chmod 0644 "$tmp"
  mv "$tmp" "$status"
}

star_web_onboarding_start_server() {
  star_web_onboarding_enabled || return 0
  local root nonce port pid_file log_file marker
  root="$(star_web_onboarding_root)"
  nonce="$(star_web_onboarding_nonce)"
  port="$(star_web_onboarding_port)"
  pid_file="$(star_web_onboarding_pid_file)"
  log_file="${root}/server.log"
  marker="$(star_web_onboarding_open_marker)"

  if [ -f "$pid_file" ]; then
    local existing_pid
    existing_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" >/dev/null 2>&1; then
      return 0
    fi
    rm -f "$pid_file"
  fi

  mkdir -p "$root"
  python3 - "$root" "$nonce" "$port" "$marker" >"$log_file" 2>&1 <<'PY' &
import http.server
import os
import pathlib
import socketserver
import sys
import time
import urllib.parse

root = pathlib.Path(sys.argv[1]).resolve()
nonce = sys.argv[2]
port = int(sys.argv[3])
marker = pathlib.Path(sys.argv[4])


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), fmt % args))

    def _safe_path(self):
        raw_path = urllib.parse.urlsplit(self.path).path
        path = urllib.parse.unquote(raw_path).lstrip("/")
        candidate = (root / path).resolve()
        if candidate == root or root in candidate.parents:
            return candidate
        return None

    def translate_path(self, path):
        safe = self._safe_path()
        if safe is None:
            return str(root / "__forbidden__")
        return str(safe)

    def _mark_opened(self):
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n", encoding="utf-8")

    def _is_continue_path(self):
        raw_path = urllib.parse.urlsplit(self.path).path
        return raw_path == f"/{nonce}/continue"

    def _continue_response(self):
        self._mark_opened()
        body = b'{"ok":true}\n'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self._is_continue_path():
            return self._continue_response()
        return super().do_GET()

    def do_HEAD(self):
        if self._is_continue_path():
            self._mark_opened()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            return
        return super().do_HEAD()

    def do_POST(self):
        if self._is_continue_path():
            return self._continue_response()
        self.send_error(404)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


os.chdir(root)
with Server(("127.0.0.1", port), Handler) as httpd:
    httpd.serve_forever()
PY
  printf '%s\n' "$!" >"$pid_file"
}

star_web_onboarding_stop_server() {
  star_web_onboarding_enabled || return 0
  local pid_file pid
  pid_file="$(star_web_onboarding_pid_file)"
  [ -f "$pid_file" ] || return 0
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid" >/dev/null 2>&1 || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" >/dev/null 2>&1 || break
      sleep 0.1
    done
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
  rm -f "$pid_file"
}

star_web_onboarding_wait_for_open() {
  star_web_onboarding_enabled || return 0
  star_web_onboarding_require_open || return 0
  local timeout="${STAR_WEB_ONBOARDING_OPEN_TIMEOUT:-900}"
  local marker
  marker="$(star_web_onboarding_open_marker)"
  printf '\nOpen this HTTPS onboarding URL, then click Start install:\n  %s\n\n' "$(star_web_onboarding_url)" >&2
  cat >&2 <<'EOF'
If this URL does not load, the VM has not properly exposed TCP port 443
publicly. Inspect the VM firewall, network tags, security group, or cloud
ingress configuration, then refresh the URL.

EOF
  printf 'Waiting up to %s seconds for the web page to start the install...\n' "$timeout" >&2
  for _ in $(seq 1 "$timeout"); do
    if [ -f "$marker" ]; then
      printf 'Web onboarding page reached. Continuing install.\n' >&2
      return 0
    fi
    sleep 1
  done
  printf '[star-web-onboarding] timed out waiting for the web page to start the install: %s\n' "$(star_web_onboarding_url)" >&2
  return 1
}

star_web_onboarding_caddy_routes() {
  local root
  root="$(star_web_onboarding_root)"
  cat <<EOF
  handle_path /star-install/* {
    root * ${root}
    file_server
  }
EOF
}

star_web_onboarding_caddy_proxy_routes() {
  cat <<EOF
  handle_path /star-install/* {
    reverse_proxy 127.0.0.1:$(star_web_onboarding_port)
  }
EOF
}

star_web_onboarding_print() {
  star_web_onboarding_enabled || return 0
  printf 'Web onboarding URL:\n  %s\n' "$(star_web_onboarding_url)"
}
