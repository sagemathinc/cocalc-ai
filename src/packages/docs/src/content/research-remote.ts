/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const RESEARCH_REMOTE_CLI_BODY = `
## Run an analysis in CoCalc from your laptop

Upload a small CSV and Python script, execute the script inside your project,
and download a verified result. All commands below run in **Bash on your own
computer**; \`project exec\` runs the specified process remotely. Python's standard
library is sufficient on both computers.

This is a single-file transfer recipe. For many files or a large directory tree,
use [SSH and rsync](/docs/terminal/ssh-access). File uploads and downloads replace
an existing destination file; choose a scratch project and unused paths.

## Prepare the connection and local files

Complete the [CLI quickstart](/docs/cli/getting-started), then replace the project
placeholder with the full ID from \`project list\`. Keep this shell open:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export REMOTE_DIR='/home/user/research-cli-demo'

cocalc --profile "$CLI_PROFILE" --json auth status --check
cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" project exec --project "$PROJECT_ID" -- pwd
cocalc --profile "$CLI_PROFILE" project exec --project "$PROJECT_ID" -- python3 --version

LOCAL_RUN=$(mktemp -d)
cd "$LOCAL_RUN"
printf 'Local example directory: %s\\n' "$LOCAL_RUN"
~~~

Confirm the account, project, and \`data.check.ok: true\` in the authentication
result. Adjust \`REMOTE_DIR\` if your project's home differs from \`/home/user\`.
\`LOCAL_RUN\` is on your computer; \`REMOTE_DIR\` is inside CoCalc. The remote process
working directory is selected by \`project exec --path\`, not \`--cwd\`.

Create these two local files:

~~~bash
cat > measurements.csv <<'CSV'
value
2
4
6
8
CSV

cat > analyze.py <<'PYTHON'
import csv
import hashlib
import io
import json
import math
from pathlib import Path
import statistics
import sys

source, destination = map(Path, sys.argv[1:3])
raw = source.read_bytes()
rows = csv.DictReader(io.StringIO(raw.decode("utf-8")))
if rows.fieldnames != ["value"]:
    raise ValueError("Expected a CSV with one column named value")
values = []
for row in rows:
    if set(row) != {"value"} or row["value"] is None:
        raise ValueError("Expected exactly one value per CSV row")
    values.append(float(row["value"]))
if not values or not all(math.isfinite(value) for value in values):
    raise ValueError("Expected at least one finite measurement")
result = {
    "count": len(values),
    "mean": statistics.mean(values),
    "input_sha256": hashlib.sha256(raw).hexdigest(),
}
destination.write_text(json.dumps(result, indent=2) + "\\n", encoding="utf-8")
print(f"Wrote {destination}: count={result['count']}, mean={result['mean']}")
PYTHON
~~~

## Upload and run

\`file put\` takes a local source followed by a remote destination. It creates
remote parent directories by default. Use the absolute remote paths shown here:

~~~bash
cocalc --profile "$CLI_PROFILE" project file put --project "$PROJECT_ID" \\
  measurements.csv "$REMOTE_DIR/measurements.csv"
cocalc --profile "$CLI_PROFILE" project file put --project "$PROJECT_ID" \\
  analyze.py "$REMOTE_DIR/analyze.py"
cocalc --profile "$CLI_PROFILE" project file list --project "$PROJECT_ID" \\
  "$REMOTE_DIR"

cocalc --profile "$CLI_PROFILE" --json project exec --project "$PROJECT_ID" \\
  --path "$REMOTE_DIR" --timeout 60 -- \\
  python3 analyze.py measurements.csv result.json > execution.json

python3 - <<'PYTHON'
import json
from pathlib import Path
response = json.loads(Path("execution.json").read_text())
assert response["ok"], response
assert response["data"]["exit_code"] == 0, response["data"]
print(response["data"]["stdout"], end="")
PYTHON
~~~

Expected stdout is \`Wrote result.json: count=4, mean=5.0\`. A successful JSON
response has \`ok: true\`, but you must also check \`data.exit_code == 0\`: a remote
program can fail even when the CLI successfully retrieves its result. Read
\`data.stderr\` for Python errors. See [scripting and results](/docs/cli/scripting-and-results).

## Download and verify the artifact

\`file get\` takes a remote source followed by a local destination. It retrieves
one file, not a recursive directory:

~~~bash
cocalc --profile "$CLI_PROFILE" project file get --project "$PROJECT_ID" \\
  "$REMOTE_DIR/result.json" downloaded-result.json

python3 - <<'PYTHON'
import hashlib
import json
from pathlib import Path
result = json.loads(Path("downloaded-result.json").read_text())
expected_hash = hashlib.sha256(Path("measurements.csv").read_bytes()).hexdigest()
assert result["count"] == 4, result
assert result["mean"] == 5.0, result
assert result["input_sha256"] == expected_hash, result
print("PASS: four measurements, mean 5.0, input checksum matches")
PYTHON
~~~

The checksum connects the result to the exact input bytes you uploaded. Keep
\`analyze.py\`, \`measurements.csv\`, \`execution.json\`, and the downloaded result
together when handing the analysis to another researcher. To reproduce the
work in a fresh project, see [reproduce an analysis](/docs/research/reproduce-analysis).

## Recover from a failed step

- **Wrong project or path:** inspect \`project get\` and \`file list\` before
  uploading again. A relative local path is interpreted on your computer;
  the paths passed after \`--path\` and as upload destinations are remote.
- **Python is unavailable:** select a suitable project environment or install
  it using your project's software workflow. A local Python installation does
  not install Python in CoCalc.
- **Remote execution fails:** inspect \`execution.json\`, fix the local source,
  upload that file again, and rerun. This example deterministically replaces
  only \`result.json\`; adapt retry behavior before running analyses with other
  side effects.
- **The connection times out:** inspect the remote files before retrying. A
  client timeout does not prove the command made no changes.
- **Downloaded results do not match:** compare the remote input with your local
  input and rerun the validation. Do not treat an older \`result.json\` as evidence
  that the latest execution succeeded.

After retaining the result, use CoCalc's file browser to inspect and delete only
the scratch \`research-cli-demo\` directory if you no longer need it. Your local
files remain in the directory printed as \`LOCAL_RUN\`; review them before deleting
that directory. The analysis process exits on completion, so there is no service
to stop.
`;

export const RESEARCH_CODEX_SESSIONS_BODY = `
## Review research files with a remote Codex session

Run a bounded review in a CoCalc project, retain its session identity, ask a
follow-up, and inspect or interrupt a running turn. The CLI runs the agent in
the selected project without requiring an open browser tab. Save the completed
responses locally using the commands below.

You need the [CLI quickstart](/docs/cli/getting-started), a project you can use,
and a configured Codex authentication/payment source. Run the Bash commands
below on your own computer using your account profile. Do not save your personal
account login in a shared project.

## Check access and prepare a bounded input

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export CODEX_DIR='/home/user/research-codex-demo'

cocalc --profile "$CLI_PROFILE" --json auth status --check
cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json project codex auth status \\
  --project "$PROJECT_ID"
cocalc project codex exec --help

LOCAL_CODEX=$(mktemp -d)
cd "$LOCAL_CODEX"
cat > analysis-note.md <<'MARKDOWN'
# Analysis for review

Input measurements: 2, 4, 6, 8.
Claim: their arithmetic mean is 5.
Reproducibility note: record the input checksum and Python version.
MARKDOWN

cocalc --profile "$CLI_PROFILE" project file put --project "$PROJECT_ID" \\
  analysis-note.md "$CODEX_DIR/analysis-note.md"
~~~

Adjust \`/home/user\` for your project and use a previously unused scratch path.
The Codex authentication result includes \`data.payment_source\`,
\`data.has_subscription\`, and indicators for configured account, project, or site
API keys. CLI account authentication and Codex authentication are separate:
a successful \`auth status --check\` does not establish a usable Codex source.
If the source is \`none\`, configure the intended source before running a turn.
For an account using a ChatGPT subscription, the CLI provides the interactive
\`project codex auth subscription login --project "$PROJECT_ID"\` flow. Complete
its displayed device authorization yourself, then check status again. Never put
an API key or authentication JSON into a prompt or research file.

## Run a read-only first turn

~~~bash
cocalc --profile "$CLI_PROFILE" --timeout 10m --json project codex exec \\
  --project "$PROJECT_ID" --workdir "$CODEX_DIR" --session-mode read-only \\
  'Read only analysis-note.md in this directory. Check the arithmetic and identify one missing reproducibility detail. Do not edit files.' \\
  > codex-turn-1.json

python3 - <<'PYTHON'
import json
from pathlib import Path
response = json.loads(Path("codex-turn-1.json").read_text())
assert response["ok"], response
result = response["data"]
assert result["thread_id"], "No returned thread ID; inspect the response"
Path("codex-session-id.txt").write_text(result["thread_id"] + "\\n")
print(result["final_response"])
print("Saved session ID:", result["thread_id"])
PYTHON

export CODEX_SESSION_ID=$(cat codex-session-id.txt)
~~~

The expected outcome is an explanation that the mean is 5 and a reproducibility
suggestion. The agent's wording varies; independently check its conclusions.
\`--workdir\` is the working directory inside the project. \`--session-mode
read-only\` requests a read-only session; use synthetic inputs when learning the
workflow and review the selected project before granting write access.

Use \`data.thread_id\` from the completed first turn as the continuation ID.
\`data.session_id\` echoes the ID you supplied and is \`null\` when the first command
omits \`--session-id\`. These fields are not interchangeable on that first result.
The JSON result also includes \`final_response\`, usage when available, and stream
counters; it is not a transcript of every event.

## Continue the same session

~~~bash
cocalc --profile "$CLI_PROFILE" --timeout 10m --json project codex exec \\
  --project "$PROJECT_ID" --workdir "$CODEX_DIR" --session-mode read-only \\
  --session-id "$CODEX_SESSION_ID" \\
  'Based on that review, propose a two-item verification checklist. Do not edit files.' \\
  > codex-turn-2.json

python3 - <<'PYTHON'
import json
from pathlib import Path
response = json.loads(Path("codex-turn-2.json").read_text())
assert response["ok"], response
print(response["data"]["final_response"])
PYTHON
~~~

Keep the same project and save each completed response. Reusing the ID asks
CoCalc to resume the Codex session; it does not mean every file remains unchanged
between turns. If resuming fails, inspect the error and existing session before
choosing to start a new session without that ID. Starting anew loses the prior
conversation context.

## Choose one output format

| Flags on \`project codex exec\` | What is written |
|---|---|
| No output flags | Final response in human-readable output. |
| \`--stream\` | Progress on stderr while the turn runs, then the normal result. |
| Global \`--json\` without streaming | One result envelope on stdout; parse \`data\`. |
| \`--jsonl\` without global \`--json\` | Raw stream-message JSON objects, one per line on stdout; no final result object. |
| Global \`--json\` with \`--stream\` | Stream messages followed by the final result envelope on stdout; not one JSON document. |

For scripts like the examples above, use plain \`--json\` and wait for the result.
For interactive progress, use \`--stream\`. If you choose JSONL, handle each
message by its \`type\`; a \`summary\` message carries \`threadId\` and \`finalResponse\`.
Do not feed a streaming output file directly to \`json.load()\` as though it were
one result. Avoid combining \`--jsonl\` with global JSON output in these recipes.

## Inspect or interrupt a running turn

Open a second local terminal while a turn is running. Set the same profile and
project ID, then inspect your own recent sessions:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'

cocalc --profile "$CLI_PROFILE" --json codex sessions \\
  --active --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json codex sessions \\
  --recent --project "$PROJECT_ID" --limit 20
~~~

The JSON \`data\` is a list of session records. Match the full project ID and
session ID, and inspect \`state\`, \`terminal\`, \`updated_at\`, \`error\`, and
\`session_key\`. Human output groups turns and shortens IDs, so use JSON to select
an exact target. Listing sessions provides status and identifiers, not their
full conversation transcripts.

To stop one specific active record, copy its full \`session_key\` and run:

~~~bash
export SESSION_KEY='REPLACE_WITH_EXACT_SESSION_KEY_FROM_THE_LIST'
cocalc --profile "$CLI_PROFILE" --json codex interrupt "$SESSION_KEY" \\
  --note 'Stopping the scratch research review'
~~~

Alternatively, the interrupt command accepts \`session:<session_id>\` or
\`op:<op_id>\`. Do not pass an unprefixed session ID when you intend the session-ID
form: an unprefixed value is interpreted as a session key. This command is
\`cocalc codex interrupt\`, not \`cocalc project codex interrupt\`.

Inspect both the outer \`ok\` and the returned \`data.ok\`, \`data.state\`,
\`data.terminal\`, and \`data.message\`. Run the session listing again to verify
whether the turn has reached a terminal state. An interrupt request can return
an uncertain result; it is not evidence that all work has already stopped.
Avoid \`interrupt-all\` when your goal is to stop only this exercise.

## Handle failures and finish

- If a turn times out or ends before its summary, inspect active sessions before
  sending the prompt again. The remote operation may still be running. Retrying
  without checking can start additional work.
- If the provider authentication or payment source fails, check the project
  Codex auth status and resolve that source. Switching the CLI account profile
  alone does not fix provider authentication.
- If the working directory or file is missing, inspect the project files and
  correct the path. \`--workdir\` does not upload your local directory.
- A notebook-tool transport timeout does not by itself show that the kernel
  stopped. Check the notebook directly and, if appropriate, run a small read-only
  cell before restarting anything. Retain the exact failed command and error for
  support; manually running code can let work continue without repairing the
  agent connection. See [notebook workflows](/docs/cli/notebook-workflows).
- If the agent reports success, verify the research claim yourself. For write
  sessions, also inspect the file changes before accepting the result.

Retain the session ID and local result files with your research notes. After
confirming no scratch turn remains active, delete the scratch input directory
through CoCalc's file browser if it is no longer useful. The session-control
commands above do not delete conversation history or undo file changes.
`;

export const RESEARCH_DASHBOARD_BODY = `
## Share a private research dashboard

Create a tiny Python dashboard backed by synthetic measurements, register it as
a managed project app, and open it with a collaborator. Python's standard
library supplies the server; no web-framework installation is needed.

Use a project in which you are an owner or collaborator with runtime access.
Viewer access cannot start or open project app servers. Managed apps use the
project's shared trust model: other code and collaborators in that project are
part of the same working environment. This tutorial creates an authenticated
project app, not an anonymous public website.

## Prepare the project and dashboard

Complete the [CLI quickstart](/docs/cli/getting-started). Run the following in
**Bash on your own computer**, where Python 3 and the CLI are installed:

~~~bash
export CLI_PROFILE=cocalc-ai
export PROJECT_ID='REPLACE_WITH_FULL_PROJECT_ID'
export DASHBOARD_DIR='/home/user/research-dashboard-demo'

cocalc --profile "$CLI_PROFILE" --json auth status --check
cocalc --profile "$CLI_PROFILE" project get --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" project exec --project "$PROJECT_ID" -- python3 --version
cocalc --profile "$CLI_PROFILE" project app list --project "$PROJECT_ID"

LOCAL_DASHBOARD=$(mktemp -d)
cd "$LOCAL_DASHBOARD"
cat > measurements.csv <<'CSV'
value
2
4
6
8
CSV

cat > dashboard.py <<'PYTHON'
import csv
import html
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import math
import os
from pathlib import Path
import statistics
from urllib.parse import urlsplit

DATA = Path(__file__).with_name("measurements.csv")

class Dashboard(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route == "/health":
            content = b"ok\\n"
            content_type = "text/plain; charset=utf-8"
        elif route == "/":
            try:
                with DATA.open(encoding="utf-8", newline="") as source:
                    reader = csv.DictReader(source)
                    if reader.fieldnames != ["value"]:
                        raise ValueError("Expected one column named value")
                    values = []
                    for row in reader:
                        if set(row) != {"value"} or row["value"] is None:
                            raise ValueError("Expected exactly one value per CSV row")
                        values.append(float(row["value"]))
                if not all(math.isfinite(value) for value in values):
                    raise ValueError("Measurements must be finite")
                mean = statistics.mean(values)
            except (OSError, ValueError, KeyError, statistics.StatisticsError):
                self.send_error(503, "Measurement data is unavailable or invalid")
                return
            rows = "".join(f"<li>{html.escape(str(value))}</li>" for value in values)
            content = (
                "<!doctype html><html lang='en'><meta charset='utf-8'>"
                "<meta name='viewport' content='width=device-width, initial-scale=1'>"
                "<title>Research measurements</title>"
                "<main><h1>Research measurements</h1>"
                f"<p>Count: {len(values)}; mean: {mean}</p><ul>{rows}</ul>"
                "<p>Refresh after updating measurements.csv.</p></main></html>"
            ).encode("utf-8")
            content_type = "text/html; charset=utf-8"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8765"))
    print(f"Dashboard listening on {host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Dashboard).serve_forever()
PYTHON

cocalc --profile "$CLI_PROFILE" project file put --project "$PROJECT_ID" \\
  measurements.csv "$DASHBOARD_DIR/measurements.csv"
cocalc --profile "$CLI_PROFILE" project file put --project "$PROJECT_ID" \\
  dashboard.py "$DASHBOARD_DIR/dashboard.py"
~~~

Adjust the remote home path if necessary. Use an unused directory and confirm
that no existing app has ID \`research-dashboard-demo\`; choose another ID
throughout this guide if it does. \`file put\` and app upserts replace existing
content at their destinations.

The same Python source is available as \`dashboard.py\` in the
[example directory](https://github.com/sagemathinc/cocalc-ai/tree/main/src/packages/docs/examples/research-workflows).

## Register the managed app

Create this JSON spec **locally**, using the selected remote directory:

~~~bash
python3 - <<'PYTHON'
import json
import os
from pathlib import Path
spec = {
    "version": 1,
    "id": "research-dashboard-demo",
    "title": "Research measurements",
    "kind": "service",
    "lifecycle": {"mode": "managed"},
    "command": {
        "exec": "python3",
        "args": ["-u", "dashboard.py"],
        "cwd": os.environ["DASHBOARD_DIR"],
    },
    "network": {"listen_host": "127.0.0.1", "port": 8765, "protocol": "http"},
    "proxy": {
        "base_path": "/apps/research-dashboard-demo",
        "strip_prefix": True,
        "websocket": False,
        "open_mode": "proxy",
        "readiness_timeout_s": 30,
    },
    "wake": {"enabled": False, "keep_warm_s": 1800, "startup_timeout_s": 30},
}
Path("dashboard-app.json").write_text(json.dumps(spec, indent=2) + "\\n")
PYTHON

cocalc --profile "$CLI_PROFILE" --json project app upsert \\
  --project "$PROJECT_ID" --file dashboard-app.json
cocalc --profile "$CLI_PROFILE" --json project app start research-dashboard-demo \\
  --project "$PROJECT_ID" --wait --timeout 30s
cocalc --profile "$CLI_PROFILE" --json project app status research-dashboard-demo \\
  --project "$PROJECT_ID"
~~~

The app manager supplies \`HOST\` and \`PORT\` to the process, so the script and
spec agree about the listener. The explicit remote \`cwd\` locates \`dashboard.py\`;
it does not point to your laptop's files. \`strip_prefix\` lets the server handle
\`/\` when a request arrives through the app's CoCalc URL. This example disables
automatic wake-up: start it explicitly, and stopping it will not allow a later
request to restart it automatically.

Require \`ok: true\`, \`data.state: "running"\`, and \`data.ready: true\`. Readiness
checks that the port accepts a connection; it does not verify the correctness
of your dataset or page. Confirm the HTTP content separately:

~~~bash
cocalc --profile "$CLI_PROFILE" project exec --project "$PROJECT_ID" -- \\
  python3 -c 'from urllib.request import urlopen; page=urlopen("http://127.0.0.1:8765/", timeout=5).read().decode(); assert "Count: 4; mean: 5.0" in page; print("PASS: dashboard serves four measurements with mean 5.0")'
~~~

This check runs inside the project. \`127.0.0.1:8765\` on your laptop refers to
your laptop, not to CoCalc. If you choose a different port in the spec, update
the verification URL too.

## Managed local forwards

For local tools, \`cocalc project app forward APP_ID --project PROJECT_ID\`
creates or reuses a managed SSH tunnel to a service app. It may start the app,
ensure/install an SSH key, and write local SSH configuration. The default
local bind address is loopback. Inspect the returned \`project_id\`,
\`app_id\`, \`local_url\`, \`forward_id\`, and \`reused\` fields before using
or stopping the tunnel; a reused tunnel may also serve another local task.

- \`project app forward-list APP_ID --project PROJECT_ID\` lists matching
  managed local forwards.
- \`project app forward-stop APP_ID --project PROJECT_ID\` can stop multiple
  matching forwards for that app.
- \`project sync forward terminate FORWARD_ID\` targets the explicit local
  forward id. Record the id from the forward response when you need to limit
  cleanup to one tunnel.

Stopping a tunnel does not stop the app or remove installed SSH keys and
configuration. App cleanup is separate, as described below. A reported running
tunnel or a TCP-ready app does not establish correct HTTP output; check the
application response separately. Local tunnel access also does not establish
that a collaborator can open the authenticated app URL.

See the [CLI command reference](/docs/cli/command-reference) for command
help and [SSH access](/docs/terminal/ssh-access) for connection setup.

## Open and share with a collaborator

1. Open the same project in CoCalc's full interface and select **Apps**.
2. Find **Research measurements** and use its open action. CoCalc constructs the
   authenticated project-host URL; do not paste a raw \`data.url\` path from the
   CLI into your laptop browser and assume it is a complete URL.
3. Confirm the heading **Research measurements** and **Count: 4; mean: 5.0**.
4. Add your colleague using [project collaborators](/docs/projects/collaborators)
   with a role that permits runtime access. Have them sign in, open that same
   project, and open the app from **Apps** themselves.
5. Confirm that both of you see the same measurements. This is the collaboration
   check; your own successful browser request alone does not verify their access.

Use CoCalc's authenticated opening flow for each person. Do not distribute
bootstrap URLs containing temporary authentication tokens. A viewer role is
suitable for reading supported project files, but is not enough to open this
running service.

To change the example, edit your local \`measurements.csv\`, upload it to the same
remote file, and refresh the page. The program reads that file on every request.
Keep an original copy of the input if the update represents a new experiment.

## Diagnose startup and data failures

~~~bash
cocalc --profile "$CLI_PROFILE" --json project app logs research-dashboard-demo \\
  --project "$PROJECT_ID" --tail 50
cocalc --profile "$CLI_PROFILE" --json project app status research-dashboard-demo \\
  --project "$PROJECT_ID"
~~~

- **Python or the script cannot be found:** inspect the app spec's \`command\`
  and the remote file paths. Install/select a Python environment if needed.
- **The port is already in use:** inspect existing project apps, choose an unused
  port in \`dashboard-app.json\`, upsert the spec, and restart this app. Do not kill
  another researcher's process just to reuse its port.
- **The page returns 503:** the listener may still be ready. Restore a valid CSV
  with a \`value\` header and at least one numeric row, then refresh.
- **The CLI wait times out:** inspect status and logs before starting again. The
  process may have started after the wait deadline.
- **A collaborator cannot open the app:** verify their project membership and
  runtime role, then have them open it through their own signed-in **Apps** page.

After changing the Python program or spec, explicitly restart the managed app:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project app restart research-dashboard-demo \\
  --project "$PROJECT_ID" --wait --timeout 30s
~~~

Recheck both the page contents and the collaborator's access when those behaviors
are affected. Captured stdout/stderr are useful diagnostics, not a durable record
of the experiment; retain the inputs and analysis results as project files.

## Stop and remove the scratch app

Close its browser tabs and stop the managed process:

~~~bash
cocalc --profile "$CLI_PROFILE" --json project app stop research-dashboard-demo \\
  --project "$PROJECT_ID"
cocalc --profile "$CLI_PROFILE" --json project app status research-dashboard-demo \\
  --project "$PROJECT_ID"
~~~

Confirm the app is stopped. When finished with the example, remove its registered
spec:

~~~bash
cocalc --profile "$CLI_PROFILE" project app delete research-dashboard-demo \\
  --project "$PROJECT_ID"
~~~

The uploaded Python and CSV files remain research files. Inspect and remove only
\`research-dashboard-demo\` in the project's file browser if no longer needed;
retain your local copies for reproduction. Stopping the app does not stop the
project itself.
`;
