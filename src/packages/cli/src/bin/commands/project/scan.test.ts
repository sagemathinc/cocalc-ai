import assert from "node:assert/strict";
import test, { beforeEach, afterEach, mock } from "node:test";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { registerProjectScanCommands } from "./scan";

let identity: string | undefined;
beforeEach(() => {
  identity = process.env.COCALC_AGENT_IDENTITY_FILE;
  delete process.env.COCALC_AGENT_IDENTITY_FILE;
});
afterEach(() => {
  if (identity === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
  else process.env.COCALC_AGENT_IDENTITY_FILE = identity;
});

function setup(fail = false) {
  const project_id = randomUUID(),
    account_id = randomUUID(),
    job_id = randomUUID();
  const calls: { method: string; input: any }[] = [];
  let output: any;
  const collaborators = Object.fromEntries(
    ["scanProjects", "inspectScan", "getScanStatus"].map((method) => [
      method,
      async (input: any) => {
        calls.push({ method, input });
        if (fail) throw Error("transport timeout");
        return method === "scanProjects"
          ? { admission: "accepted", job_id, expires_at: 123 }
          : { allowed: false, retry_after_ms: 1000 };
      },
    ]),
  );
  const program = new Command().exitOverride();
  registerProjectScanCommands(program.command("project"), {
    withContext: async (_command: unknown, _name: string, action: any) => {
      calls.push({ method: "context", input: null });
      output = await action({ accountId: account_id, hub: { collaborators } });
    },
    resolveProjectFromArgOrContext: async () => ({ project_id }),
  } as any);
  const run = (args: string[]) =>
    program.parseAsync(["project", "scan", ...args], { from: "user" });
  return { run, calls, project_id, account_id, job_id, output: () => output };
}

test("request reports stable identity before sending and never retries unknown outcomes", async () => {
  for (const fail of [false, true]) {
    const f = setup(fail),
      request_id = randomUUID();
    let message = "";
    const stderr = mock.method(process.stderr, "write", (chunk: any) => {
      assert.equal(
        f.calls.some((c) => c.method === "scanProjects"),
        false,
      );
      message += chunk;
      return true;
    });
    try {
      const run = f.run([
        "request",
        "--request-id",
        request_id,
        "--mode",
        "reconcile",
      ]);
      if (fail) await assert.rejects(run, /transport timeout/);
      else await run;
      assert.ok(message.includes(request_id));
      assert.ok(message.includes(f.project_id));
      assert.deepEqual(
        f.calls.filter((c) => c.method !== "context"),
        [
          {
            method: "scanProjects",
            input: {
              account_id: f.account_id,
              project_ids: [f.project_id],
              request_id,
              action: "start",
            },
          },
        ],
      );
      if (!fail) assert.equal(f.output().request_id, request_id);
    } finally {
      stderr.mock.restore();
    }
  }
});

test("generated request identity is printed before submission and returned", async () => {
  const f = setup();
  let message = "";
  const stderr = mock.method(process.stderr, "write", (chunk: any) => {
    message += chunk;
    return true;
  });
  try {
    await f.run(["request"]);
    const sent = f.calls.find((call) => call.method === "scanProjects")!.input;
    assert.match(sent.request_id, /^[0-9a-f-]{36}$/);
    assert.ok(message.includes(sent.request_id));
    assert.equal(sent.action, "start");
    assert.equal(f.output().request_id, sent.request_id);
  } finally {
    stderr.mock.restore();
  }
});

test("inspection and status return throttling unchanged without submitting or polling", async () => {
  for (const [command, option, field, method] of [
    ["inspect", "--request-id", "request_id", "inspectScan"],
    ["status", "--job-id", "job_id", "getScanStatus"],
  ]) {
    const f = setup(),
      value = randomUUID();
    await f.run([command, option, value]);
    assert.deepEqual(
      f.calls.filter((c) => c.method !== "context"),
      [
        {
          method,
          input: {
            account_id: f.account_id,
            project_id: f.project_id,
            [field]: value,
          },
        },
      ],
    );
    assert.deepEqual(f.output(), {
      project_id: f.project_id,
      [field]: value,
      allowed: false,
      retry_after_ms: 1000,
    });
  }
});

test("invalid input and agent identity fail before authentication", async () => {
  for (const args of [
    ["start"],
    ["start", "--all", "--projects", randomUUID()],
    ["start", "--projects", "bad"],
    ["cancel"],
    ["request", "--mode", "force"],
    ["request", "--request-id", "bad"],
    ["inspect", "--request-id", "bad"],
    ["status", "--job-id", "bad"],
  ]) {
    const f = setup();
    await assert.rejects(f.run(args));
    assert.deepEqual(f.calls, []);
  }
  process.env.COCALC_AGENT_IDENTITY_FILE = "/identity";
  for (const args of [
    ["request"],
    ["start", "--all"],
    ["batch-status"],
    ["cancel", "--op-id", randomUUID()],
    ["inspect", "--request-id", randomUUID()],
    ["status", "--job-id", randomUUID()],
  ]) {
    const f = setup();
    await assert.rejects(f.run(args), /human account/);
    assert.deepEqual(f.calls, []);
  }
});

test("batch commands preserve explicit selection, identity, and cancellation target", async () => {
  const stderr = mock.method(process.stderr, "write", () => true);
  try {
    for (const all of [false, true]) {
      const f = setup(),
        request_id = randomUUID(),
        second = randomUUID();
      await f.run([
        "start",
        ...(all ? ["--all"] : ["--projects", `${f.project_id},${second}`]),
        "--request-id",
        request_id,
      ]);
      assert.deepEqual(
        f.calls.filter((c) => c.method !== "context"),
        [
          {
            method: "scanProjects",
            input: {
              account_id: f.account_id,
              action: "start",
              request_id,
              project_ids: all ? "all" : [f.project_id, second],
            },
          },
        ],
      );
    }
    for (const action of ["status", "cancel"]) {
      const f = setup(),
        op_id = randomUUID();
      await f.run([
        action === "status" ? "batch-status" : "cancel",
        "--op-id",
        op_id,
      ]);
      assert.deepEqual(
        f.calls.filter((c) => c.method !== "context"),
        [
          {
            method: "scanProjects",
            input: {
              account_id: f.account_id,
              action,
              op_id,
              ...(action === "status" ? { after: undefined } : {}),
            },
          },
        ],
      );
    }
  } finally {
    stderr.mock.restore();
  }
});
