// Run after `pnpm build`: node --test acp/__tests__/harness-client.test.cjs
// Compiled tests exercise the real ESM SDK, not a mocked Jest transform.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { AcpHarnessClient } = require("../../dist/acp/harness-client.js");
const { parseAcpHarnessProfile } = require("@cocalc/util/ai/runtime");

const profile = {
  version: 1,
  kind: "acp",
  id: "fixture",
  revision: "1",
  executable: process.execPath,
  args: [path.join(__dirname, "fixtures/acp-harness.cjs")],
  cwd: "/tmp",
  credentialMode: "project-managed",
  executionPolicy: "full-access",
};
async function start(t, args = []) {
  let child;
  const client = await AcpHarnessClient.start(
    {
      projectId: "project-a",
      accountId: "account-a",
      profile: { ...profile, args: [...profile.args, ...args] },
    },
    async ({ profile }) => {
      child = spawn(profile.executable, profile.args, {
        cwd: profile.cwd,
        env: {},
        stdio: "pipe",
      });
      const closed = new Promise((resolve) => {
        child.once("close", resolve);
        child.once("error", resolve);
      });
      t.after(async () => {
        child.kill("SIGKILL");
        await closed;
      });
      return {
        stdout: child.stdout,
        stdin: child.stdin,
        stderr: child.stderr,
        closed,
        stop: async () => {
          child.kill("SIGKILL");
          await closed;
        },
      };
    },
    1500,
  );
  t.after(() => client.dispose());
  return client;
}
test("strict profile validation and defensive copy", () => {
  const parsed = parseAcpHarnessProfile(profile);
  assert.deepEqual(parsed, profile);
  parsed.args.push("different");
  assert.notDeepEqual(parsed.args, profile.args);
  for (const changes of [
    { version: 2 },
    { executionPolicy: "read-only" },
    { executable: "sh" },
    { cwd: "relative" },
    { credentialMode: "account" },
    { env: { SECRET: "secret" } },
    { args: ["\0"] },
  ]) {
    assert.throws(() => parseAcpHarnessProfile({ ...profile, ...changes }));
  }
});
test("negotiates, opens, streams in order, drains before completion, reuses session", async (t) => {
  const client = await start(t);
  assert.equal(client.capabilities.agentInfo.name, "cocalc-fixture");
  await client.open();
  const events = [];
  const collect = async (event) => {
    await new Promise((r) => setTimeout(r, 5));
    events.push(event);
  };
  assert.equal((await client.prompt("hi", collect)).stopReason, "end_turn");
  assert.deepEqual(
    events.map((e) => e.text),
    ["Hello ", "world 1"],
  );
  await client.prompt("hi again", collect);
  assert.equal(events.at(-1).text, "world 2");
  assert.equal(client.sessionId, "fixture-session");
});
test("cancellation returns confirmed stop reason without resubmission", async (t) => {
  const client = await start(t);
  await client.open();
  let observed;
  const ready = new Promise((r) => {
    observed = r;
  });
  const turn = client.prompt("hang", async () => observed());
  await ready;
  await assert.rejects(
    client.prompt("parallel", async () => {}),
    /idle/,
  );
  await client.cancel();
  assert.equal((await turn).stopReason, "cancelled");
});
test("full-access permission chooses only offered allow-once", async (t) => {
  const client = await start(t);
  await client.open();
  const events = [];
  await client.prompt("permission", async (e) => {
    events.push(e);
  });
  assert.equal(events[0].outcome, "allowed");
  assert.match(events[1].text, /"optionId":"allow"/);
});
test("resume does not append replayed history as a new answer", async (t) => {
  const client = await start(t);
  await client.open("fixture-session");
  const events = [];
  await client.prompt("hi", async (e) => {
    events.push(e);
  });
  assert.deepEqual(
    events.map((e) => e.text),
    ["Hello ", "world 1"],
  );
});
test("unsupported resume never silently creates a new session", async (t) => {
  const client = await start(t, ["--no-resume"]);
  await assert.rejects(client.open("old"), (e) => e.code === "unsupported");
  assert.equal(client.sessionId, undefined);
});
for (const prompt of [
  "crash",
  "malformed",
  "oversized",
  "truncated",
  "wrong-session",
]) {
  test(`${prompt} is outcome unknown, redacted, and never retried`, async (t) => {
    const client = await start(t);
    await client.open();
    await assert.rejects(
      client.prompt(prompt, async () => {}),
      (e) => e.code === "outcome_unknown" && !e.message.includes("secret"),
    );
    await assert.rejects(
      client.prompt("hi", async () => {}),
      (e) => e.code === "unavailable",
    );
  });
}
test("provider rejection is distinct from ambiguous delivery and is redacted", async (t) => {
  const client = await start(t);
  await client.open();
  await assert.rejects(
    client.prompt("reject", async () => {}),
    (e) => e.code === "rejected" && !e.message.includes("secret"),
  );
});
test("failed output persistence does not report success", async (t) => {
  const client = await start(t);
  await client.open();
  await assert.rejects(
    client.prompt("hi", async () => {
      throw Error("db unavailable");
    }),
    (e) => e.code === "outcome_unknown",
  );
});
test("protocol mismatch fails closed", async (t) => {
  await assert.rejects(
    start(t, ["--wrong-version"]),
    (e) => e.code === "unsupported",
  );
});
test("startup has a timeout, not an unlimited wait", async (t) => {
  await assert.rejects(start(t, ["--hang"]), (e) => e.code === "unavailable");
});

test("concurrent session opens cannot replace the native session", async (t) => {
  const client = await start(t);
  const opening = client.open();
  await assert.rejects(client.open(), /opening/);
  await opening;
});

test("ignored cancellation terminates runtime and reports uncertainty", async (t) => {
  const client = await start(t, ["--ignore-cancel"]);
  await client.open();
  let seen;
  const ready = new Promise((resolve) => {
    seen = resolve;
  });
  const turn = client.prompt("hang", async () => seen());
  const assertion = assert.rejects(turn, (e) => e.code === "outcome_unknown");
  await ready;
  await client.cancel();
  await assertion;
});

test("a stalled output consumer cannot buffer unlimited events", async (t) => {
  const client = await start(t);
  await client.open();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await assert.rejects(
      client.prompt("flood", () => blocked),
      (e) => e.code === "outcome_unknown",
    );
  } finally {
    release();
  }
});

test("canceling while a permission event is pending never grants permission", async (t) => {
  const client = await start(t);
  await client.open();
  let release, seen;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    seen = resolve;
  });
  const events = [];
  const turn = client.prompt("permission", async (event) => {
    if (event.type === "permission") {
      seen();
      await blocked;
    }
    events.push(event);
  });
  await ready;
  await client.cancel();
  release();
  await turn;
  assert.match(events.at(-1).text, /cancelled/);
});
