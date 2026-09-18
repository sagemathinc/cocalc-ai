const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const transport = require("@cocalc/conat/core/client");
const { run } = require("./agent-messaging-lost-ack.cjs");

test("lost-ack adapter wraps one exact session attempt without retries", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "agent-lost-ack-"));
  const old = process.env.COCALC_AGENT_IDENTITY_FILE;
  const credential = {
    agent_id: randomUUID(),
    run_id: randomUUID(),
    token: "cocalc_agent_identity_qa",
    expires_at: Date.now() + 60000,
    api_url: "https://owner.invalid",
  };
  let calls = 0;
  let closes = 0;
  let outcome = "accepted";
  const patch = mock.method(transport, "connect", (options) => {
    assert.deepEqual(options.auth, { bearer: credential.token });
    assert.equal(options.address, credential.api_url);
    return {
      request: async (_subject, body) => {
        calls++;
        return {
          data: {
            result: {
              version: 3,
              outcome,
              target: body.target,
              agent_session_id: body.agent_session_id,
              attempt_id: body.attempt_id,
              observed_at: Date.now(),
            },
          },
        };
      },
      close: () => closes++,
    };
  });
  try {
    process.env.COCALC_AGENT_IDENTITY_FILE = join(dir, "identity");
    await fs.writeFile(
      process.env.COCALC_AGENT_IDENTITY_FILE,
      JSON.stringify(credential),
      { mode: 0o600 },
    );
    const args = [
      credential.agent_id,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      join(dir, "evidence"),
    ];
    const first = await run(args);
    assert.equal(first.passed, true);
    assert.equal(first.result.outcome, "unknown");
    assert.equal(first.result.agent_session_id, args[1]);
    const evidence = await fs.readFile(args[5], "utf8");
    assert.ok(evidence.includes('"accepted-ack-discarded"'));
    assert.ok(!evidence.includes(credential.token));
    assert.ok(!evidence.includes("Lost-ack QA"));
    await assert.rejects(run(args), /EEXIST/);
    await assert.rejects(
      run([randomUUID(), ...args.slice(1)]),
      /Wrong scoped QA agent/,
    );
    assert.equal(calls, 1);
    assert.equal(closes, 1);

    outcome = "rejected";
    const rejected = await run([...args.slice(0, 5), join(dir, "rejection")]);
    assert.equal(rejected.passed, false);
    assert.equal(rejected.result.outcome, "rejected");
    assert.ok(
      !(await fs.readFile(join(dir, "rejection"), "utf8")).includes(
        '"accepted-ack-discarded"',
      ),
    );
    assert.equal(calls, 2);
    assert.equal(closes, 2);
  } finally {
    patch.mock.restore();
    if (old === undefined) delete process.env.COCALC_AGENT_IDENTITY_FILE;
    else process.env.COCALC_AGENT_IDENTITY_FILE = old;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
