/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { sandboxExec } from "./sandbox-exec";

// Run as the project-host runtime user against an explicitly chosen disposable
// project on a host with the new privileged helper installed. Never infer a
// target from the current interactive project/environment.
const project = process.env.COCALC_TEST_MANAGED_PROJECT_ID;
const integration = project ? test : test.skip;

integration.each(["cancel", "deadline", "success"])(
  "Podman project exec contains a double-forked descendant on %s",
  async (mode) => {
    const abort = new AbortController();
    let output = "";
    let pid: number | undefined;
    let start: string | undefined;
    try {
      const result = await sandboxExec({
        project_id: project!,
        signal: abort.signal,
        timeoutMs: mode === "deadline" ? 3000 : 15000,
        onOutput: (stream, data) => {
          if (stream !== "stdout") return;
          output += data;
          if (output.includes("\n") && pid === undefined) {
            const record = JSON.parse(output.split("\n")[0]);
            pid = record.pid;
            start = record.start;
            if (mode === "cancel") abort.abort();
          }
        },
        script: `/usr/bin/python3 - <<'PY'
import os,signal,time,json
r,w=os.pipe()
if os.fork()==0:
    os.close(r)
    os.setsid()
    if os.fork()!=0: os._exit(0)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    stat=open('/proc/self/stat').read().rsplit(')',1)[1].split()
    os.write(w,(json.dumps({'pid':os.getpid(),'start':stat[19]})+'\\n').encode())
    os.close(w)
    while True: time.sleep(1)
os.close(w)
print(os.read(r,1024).decode(),end='',flush=True)
os.close(r)
${mode === "success" ? "" : "time.sleep(60)"}
PY`,
      });
      expect(pid).toEqual(expect.any(Number));
      expect(result.cleanupConfirmed).toBe(true);
      expect(result.code).toBe(mode === "success" ? 0 : 130);
      const check = await sandboxExec({
        project_id: project!,
        script: `/usr/bin/python3 - <<'PY'
from pathlib import Path
p=Path('/proc/${pid}/stat')
s=p.read_text().rsplit(')',1)[1].split() if p.exists() else []
assert not s or s[0]=='Z' or s[19]!=${JSON.stringify(start)}
PY`,
        timeoutMs: 10000,
      });
      expect(check.code).toBe(0);
    } finally {
      abort.abort();
      // A failed regression must not leave its intentionally detached fixture.
      if (Number.isSafeInteger(pid) && /^\d+$/.test(start ?? ""))
        await sandboxExec({
          project_id: project!,
          script: `/usr/bin/python3 - <<'PY'
import os,signal
from pathlib import Path
p=Path('/proc/${pid}/stat')
s=p.read_text().rsplit(')',1)[1].split() if p.exists() else []
if s and s[0]!='Z' and s[19]==${JSON.stringify(start)}: os.kill(${pid},signal.SIGKILL)
PY`,
          timeoutMs: 10000,
        });
    }
  },
  40000,
);
