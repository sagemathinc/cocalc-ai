// Run after `pnpm build`: node --test acp/__tests__/harness-client.test.cjs
// Compiled tests exercise the real ESM SDK, not a mocked Jest transform.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { AcpHarnessClient } = require("../../dist/acp/harness-client.js");
const { parseAcpHarnessProfile } = require("@cocalc/util/ai/runtime");
const { HarnessAgent } = require("../../dist/acp/harness-agent.js");
const { harnessPrompt } = require("../../dist/acp/harness-context.js");
const { harnessQuestionForm } = require("../../dist/acp/harness-questions.js");

const claudeAgentAcpBin = process.env.CLAUDE_AGENT_ACP_BIN;

test(
  "qualified Claude adapter negotiates ACP v1 without subscription auth",
  { skip: !claudeAgentAcpBin },
  async (t) => {
    const probeProfile = {
      version: 1,
      kind: "acp",
      id: "claude-code",
      revision: "0.79.0",
      executable: claudeAgentAcpBin,
      args: ["--hide-claude-auth"],
      cwd: "/tmp",
      credentialMode: "project-managed",
      executionPolicy: "full-access",
    };
    const client = await AcpHarnessClient.start(
      {
        projectId: "qualification-project",
        accountId: "qualification-account",
        profile: probeProfile,
      },
      async ({ profile }) => {
        const child = spawn(profile.executable, profile.args, {
          cwd: profile.cwd,
          env: {
            HOME:
              process.env.CLAUDE_AGENT_ACP_PROBE_HOME ??
              "/tmp/cocalc-claude-agent-acp-probe",
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
          },
          stdio: "pipe",
        });
        const closed = new Promise((resolve) => {
          child.once("close", resolve);
          child.once("error", resolve);
        });
        return {
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          closed,
          stop: async () => {
            child.kill("SIGKILL");
            await closed;
          },
        };
      },
    );
    t.after(() => client.dispose());

    const info = client.capabilities;
    assert.equal(info.protocolVersion, 1);
    assert.deepEqual(info.agentInfo, {
      name: "@agentclientprotocol/claude-agent-acp",
      title: "Claude Agent",
      version: "0.79.0",
    });
    assert.deepEqual(info.authMethods, []);
    assert.equal(info.agentCapabilities.loadSession, true);
    assert.equal(info.agentCapabilities.promptCapabilities.image, true);
    assert.deepEqual(info.agentCapabilities.sessionCapabilities.subagents, {});
  },
);

function questionForm() {
  return {
    mode: "form",
    sessionId: "native-session",
    message: "Which target?",
    requestedSchema: {
      type: "object",
      required: ["target"],
      properties: {
        target: { type: "string", title: "Target", enum: ["staging", "local"] },
      },
    },
  };
}
test("ACP form questions retain exact choice values and decline explicitly", () => {
  const source = questionForm();
  const form = harnessQuestionForm(source);
  source.requestedSchema.properties.target.enum[0] = "changed";
  assert.equal(form.sessionId, "native-session");
  assert.equal(form.questions[0].isOther, false);
  assert.match(form.questions[0].question, /Do not enter passwords/);
  assert.deepEqual(form.response({ target: { answers: ["staging"] } }), {
    action: "accept",
    content: { target: "staging" },
  });
  assert.deepEqual(form.response({ target: { answers: [] } }), {
    action: "decline",
  });
  for (const answers of [
    {},
    { target: { answers: ["changed"] } },
    { target: { answers: ["staging", "local"] } },
    { target: { answers: ["local"] }, extra: { answers: ["ignored"] } },
  ])
    assert.throws(() => form.response(answers));
});
test("ACP form questions enforce Unicode length and reject partial required answers", () => {
  const source = questionForm();
  source.requestedSchema.properties = {
    target: { type: "string", minLength: 1, maxLength: 2 },
    reason: { type: "string" },
  };
  source.requestedSchema.required.push("reason");
  const form = harnessQuestionForm(source);
  assert.deepEqual(
    form.response({
      target: { answers: ["\u{1f30e}"] },
      reason: { answers: ["test"] },
    }),
    {
      action: "accept",
      content: { target: "\u{1f30e}", reason: "test" },
    },
  );
  assert.throws(() =>
    form.response({
      target: { answers: ["abc"] },
      reason: { answers: ["test"] },
    }),
  );
  assert.throws(() =>
    form.response({ target: { answers: ["ok"] }, reason: { answers: [] } }),
  );
});
test("ACP form questions reject unsupported schema constraints and non-session elicitation", () => {
  for (const mutate of [
    (x) => (x.mode = "url"),
    (x) => delete x.sessionId,
    (x) => (x.requestId = "auth-start"),
    (x) => (x.requestedSchema.required = []),
    (x) => (x.requestedSchema.properties.target.type = "object"),
    (x) => (x.requestedSchema.properties.target.format = "password"),
    (x) => (x.requestedSchema.properties.target.pattern = "local"),
    (x) => (x.requestedSchema.properties.target.default = "local"),
    (x) => (x.requestedSchema.properties.target.enum = ["same", "same"]),
    (x) => (x.requestedSchema.properties.target.maxLength = 9000),
    (x) => (x.message = "x".repeat(4097)),
    (x) => (x.requestedSchema.additionalProperties = true),
  ]) {
    const source = questionForm();
    mutate(source);
    assert.throws(
      () => harnessQuestionForm(source),
      /Unsupported ACP question form/,
    );
  }
});

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

function adapter(t, flags = [], attention, cleanupFails = false) {
  let launches = 0;
  let stops = 0;
  const agent = new HarnessAgent(
    {
      projectId: "project-a",
      accountId: "account-a",
      profile: { ...profile, args: [...profile.args, ...flags] },
    },
    { path: "a.chat", threadId: "conversation-a" },
    async ({ profile }) => {
      launches++;
      const child = spawn(profile.executable, profile.args, {
        env: {},
        stdio: "pipe",
      });
      const closed = new Promise((resolve) => {
        child.once("close", resolve);
        child.once("error", resolve);
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        closed,
        stop: async () => {
          stops++;
          child.kill("SIGKILL");
          await closed;
          if (cleanupFails) throw Error("test launcher stop failed");
        },
      };
    },
    attention,
  );
  t.after(() =>
    agent.dispose().catch((error) => {
      if (!cleanupFails) throw error;
    }),
  );
  const events = [];
  const request = {
    project_id: "project-a",
    account_id: "account-a",
    prompt: "hello",
    chat: {
      project_id: "project-a",
      path: "a.chat",
      thread_id: "conversation-a",
    },
    stream: async (event) => {
      events.push(event);
    },
  };
  return {
    agent,
    request,
    events,
    launches: () => launches,
    stops: () => stops,
  };
}

test("harness adapter binds durable questions to the current account, chat and execution", async (t) => {
  const asked = [],
    resolved = [],
    closed = [];
  const attention = {
    requestSyncQuestion: async (q) => {
      asked.push(q);
      return { target: { answers: ["local"] } };
    },
    serverRequestResolved: async (q) => resolved.push(q),
    runtimeClosed: async (context) => closed.push(context),
  };
  const { agent, request } = adapter(t, [], attention);
  await agent.evaluate({ ...request, prompt: "question" });
  await agent.evaluate({
    ...request,
    prompt: "question",
    session_id: "fixture-session",
  });
  assert.equal(asked.length, 2);
  assert.equal(resolved.length, 2);
  assert.equal(asked[0].context.accountId, "account-a");
  assert.equal(asked[0].context.chat.thread_id, "conversation-a");
  assert.equal(asked[0].context.threadId, "fixture-session");
  assert.notEqual(asked[0].context.turnId, asked[1].context.turnId);
  assert.equal(resolved[0].requestId, asked[0].requestId);
  assert.equal(closed[0].turnId, asked[0].context.turnId);
});

test("invalid question answers never resolve a durable attention request", async (t) => {
  let resolved = 0;
  const { agent, request } = adapter(t, [], {
    requestSyncQuestion: async () => ({
      target: { answers: ["not-an-option"] },
    }),
    serverRequestResolved: async () => resolved++,
    runtimeClosed: async () => {},
  });
  await agent.evaluate({ ...request, prompt: "question" });
  assert.equal(resolved, 0);
});

test("interrupting a durable harness question aborts its waiter and closes the execution context", async (t) => {
  let ready, signal, closed;
  const entered = new Promise((resolve) => (ready = resolve));
  const { agent, request } = adapter(t, [], {
    requestSyncQuestion: async (q) => {
      signal = q.signal;
      ready();
      return new Promise((_resolve, reject) =>
        q.signal.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        }),
      );
    },
    runtimeClosed: async (context) => {
      closed = context;
    },
  });
  const pending = agent
    .evaluate({ ...request, prompt: "question" })
    .catch(() => {});
  await entered;
  assert.equal(await agent.interruptOutstanding("fixture-session"), true);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(closed.chat.thread_id, "conversation-a");
});

test("agent adapter persists streaming and stop before summary and reuses its session", async (t) => {
  const { agent, request, events, launches } = adapter(t);
  await agent.evaluate(request);
  assert.equal(events.at(-1).finalResponse, "Hello world 1");
  assert.equal(events.at(-2).event.data.stopReason, "end_turn");
  assert.equal(events.at(-1).usage, undefined);
  assert.equal(events[0].threadId, "fixture-session");
  await agent.evaluate({ ...request, session_id: "fixture-session" });
  assert.equal(events.at(-1).finalResponse, "Hello world 2");
  assert.equal(launches(), 1);
});

test("fixture recognizes settings commands after the worker queue-delay note", async (t) => {
  const { agent, request, events } = adapter(t);
  await agent.evaluate({
    ...request,
    prompt:
      "System note: this message was queued for 30 seconds while another turn was active, and is being sent automatically now.\n\nsettings",
  });
  assert.equal(events.at(-1).finalResponse, "fast/code");
});

test("agent adapter rejects mismatched authority and unsupported options before launching", async (t) => {
  const { agent, request, launches } = adapter(t);
  for (const change of [
    { account_id: "other" },
    { project_id: "other" },
    { chat: { ...request.chat, thread_id: "other" } },
    { local_images: ["image.png"] },
    { config: { model: "codex" } },
    { runtime_env: { SECRET: "not-forwarded" } },
  ])
    await assert.rejects(agent.evaluate({ ...request, ...change }));
  assert.equal(launches(), 0);
  await agent.evaluate(request);
  await assert.rejects(agent.evaluate({ ...request, session_id: "other" }));
  assert.equal(launches(), 1);
});

test("adapter preserves generic tool lifecycle updates for activity rendering", async (t) => {
  const { agent, request, events } = adapter(t);
  await agent.evaluate({ ...request, prompt: "tools" });
  const updates = events
    .filter((event) => event.event?.kind === "update")
    .map((event) => event.event.data);
  assert.deepEqual(
    updates.map((update) => update.status),
    ["in_progress", "completed"],
  );
  assert.equal(updates[1].toolCallId, "inspect");
  assert.equal(
    updates[1].content[0].content.text,
    "Fixture tool output verified.",
  );
});

test("agent applies admitted settings and publishes controls while retaining its process", async (t) => {
  const { agent, request, events, launches } = adapter(t, ["--config-options"]);
  const runtime = {
    version: 1,
    kind: "acp",
    profile,
    settings: { configOptions: [{ id: "model", value: "deep" }] },
  };
  await agent.evaluate({ ...request, prompt: "settings", runtime });
  assert.equal(events.at(-1).finalResponse, "deep/code");
  const controls = events.find((event) => event.event?.kind === "controls")
    .event.data.controls;
  assert.equal(controls.configOptions[0].currentValue, "deep");
  await agent.evaluate({
    ...request,
    prompt: "settings",
    runtime: {
      ...runtime,
      settings: { configOptions: [{ id: "model", value: "fast" }] },
    },
  });
  assert.equal(events.at(-1).finalResponse, "fast/code");
  assert.equal(launches(), 1);
});

test("agent adapter never summarizes or relaunches an uncertain prompt", async (t) => {
  const { agent, request, events, launches } = adapter(t);
  await assert.rejects(agent.evaluate({ ...request, prompt: "crash" }), {
    code: "outcome_unknown",
  });
  assert.ok(!events.some((event) => event.type === "summary"));
  await assert.rejects(agent.evaluate(request));
  assert.equal(launches(), 1);
});

test("cleanup failure preserves uncertain delivery and warns that termination is unconfirmed", async (t) => {
  const { agent, request, events, launches, stops } = adapter(
    t,
    [],
    undefined,
    true,
  );
  await assert.rejects(
    agent.evaluate({ ...request, prompt: "crash" }),
    (error) => {
      assert.equal(error.code, "outcome_unknown");
      assert.match(error.message, /do not automatically resend/);
      assert.match(error.message, /cleanup could not be confirmed/);
      assert.ok(!error.message.includes("test launcher"));
      return true;
    },
  );
  assert.ok(!events.some((event) => event.type === "summary"));
  await assert.rejects(agent.evaluate(request), /not idle/);
  assert.equal(launches(), 1);
  assert.equal(stops(), 1);
});

test("attention cleanup failure does not replace uncertain delivery", async (t) => {
  let closes = 0;
  const { agent, request, events, stops } = adapter(t, [], {
    requestSyncQuestion: async () => ({}),
    runtimeClosed: async (context) => {
      if (!context) return;
      closes++;
      throw Error("test attention store unavailable");
    },
  });
  await assert.rejects(
    agent.evaluate({ ...request, prompt: "crash" }),
    (error) => {
      assert.equal(error.code, "outcome_unknown");
      assert.match(error.message, /do not automatically resend/);
      assert.match(error.message, /cleanup could not be confirmed/);
      return true;
    },
  );
  assert.equal(closes, 1);
  assert.equal(stops(), 1);
  assert.ok(!events.some((event) => event.type === "summary"));
  await assert.rejects(agent.evaluate(request), /not idle/);
});

test("failed attention finalization does not publish a successful summary or retain the runtime", async (t) => {
  const { agent, request, events, stops } = adapter(t, [], {
    requestSyncQuestion: async () => ({}),
    runtimeClosed: async (context) => {
      if (context) throw Error("test attention store unavailable");
    },
  });
  await assert.rejects(agent.evaluate(request));
  assert.ok(!events.some((event) => event.type === "summary"));
  assert.equal(stops(), 1);
  await assert.rejects(agent.evaluate(request), /not idle/);
});

test("process cleanup failure still finalizes the current attention context", async (t) => {
  const closed = [];
  const { agent, request } = adapter(
    t,
    [],
    {
      requestSyncQuestion: async () => ({}),
      runtimeClosed: async (context) => {
        if (context) closed.push(context);
      },
    },
    true,
  );
  await assert.rejects(agent.evaluate({ ...request, prompt: "crash" }), {
    code: "outcome_unknown",
  });
  assert.equal(closed.length, 1);
  assert.equal(closed[0].chat.thread_id, "conversation-a");
  assert.equal(closed[0].accountId, "account-a");
});

for (const phase of ["startup", "retained rejection"]) {
  test(`cleanup failure preserves ${phase} classification`, async (t) => {
    const { agent, request, events, launches, stops } = adapter(
      t,
      phase === "startup" ? ["--wrong-version"] : [],
      undefined,
      true,
    );
    if (phase !== "startup") {
      await agent.evaluate(request);
      events.length = 0;
    }
    await assert.rejects(
      agent.evaluate({ ...request, prompt: "reject" }),
      (error) => {
        assert.equal(
          error.code,
          phase === "startup" ? "unsupported" : "rejected",
        );
        assert.match(error.message, /cleanup could not be confirmed/);
        assert.ok(!error.message.includes("test launcher"));
        return true;
      },
    );
    assert.ok(!events.some((event) => event.type === "summary"));
    await assert.rejects(agent.evaluate(request), /not idle/);
    assert.equal(launches(), 1);
    assert.equal(stops(), 1);
  });
}

for (const phase of [
  "status",
  "initial controls",
  "message",
  "final controls",
  "stop",
  "summary",
]) {
  for (const retained of [false, true]) {
    test(`${retained ? "retained" : "new"} adapter stops without relaunch after persistence failure at ${phase}`, async (t) => {
      const { agent, request, events, launches, stops } = adapter(t);
      if (retained) {
        await agent.evaluate(request);
        assert.equal(events.at(-1).finalResponse, "Hello world 1");
        events.length = 0;
      }
      let controls = 0;
      let failed = false;
      let callsAfterFailure = 0;
      const error = new Error(`storage unavailable at ${phase}`);
      await assert.rejects(
        agent.evaluate({
          ...request,
          stream: async (event) => {
            if (failed) callsAfterFailure++;
            if (event.event?.kind === "controls") controls++;
            const current =
              event.type === "status" || event.type === "summary"
                ? event.type
                : event.event?.kind === "controls"
                  ? controls === 1
                    ? "initial controls"
                    : "final controls"
                  : event.event?.kind === "stop"
                    ? "stop"
                    : event.event?.type;
            if (current === phase) {
              failed = true;
              throw error;
            }
            events.push(event);
          },
        }),
        phase === "message" ? { code: "outcome_unknown" } : error,
      );
      assert.equal(
        failed,
        true,
        "the selected persistence boundary was reached",
      );
      assert.equal(callsAfterFailure, 0);
      assert.ok(!events.some((event) => event.type === "summary"));
      assert.equal(
        stops(),
        1,
        "the failed process was stopped before returning",
      );
      assert.equal(agent.hasRunningTurn("fixture-session"), false);
      await assert.rejects(agent.evaluate(request), /not idle/);
      assert.equal(
        launches(),
        1,
        "a failed turn cannot silently create a new process",
      );
      await agent.dispose();
      assert.equal(stops(), 1, "cleanup remains idempotent");
    });
  }
}

for (const stopReason of ["max_tokens", "max_turn_requests", "refusal"]) {
  for (const partial of [false, true]) {
    test(`adapter preserves ${stopReason}, partial=${partial}, without reporting success`, async (t) => {
      const { agent, request, events, launches, stops } = adapter(t);
      await assert.rejects(
        agent.evaluate({
          ...request,
          prompt: `stop:${stopReason}${partial ? ":partial" : ""}`,
        }),
        (error) =>
          error.code === "rejected" &&
          error.message === `ACP prompt stopped: ${stopReason}`,
      );
      assert.deepEqual(
        events
          .filter((e) => e.event?.type === "message")
          .map((e) => e.event.text),
        partial ? ["Partial output before stopping."] : [],
      );
      assert.deepEqual(
        events.filter((e) => e.event?.kind === "stop").map((e) => e.event.data),
        [{ stopReason }],
      );
      assert.ok(!events.some((e) => e.type === "summary"));
      assert.equal(stops(), 1);
      assert.equal(agent.hasRunningTurn("fixture-session"), false);
      await assert.rejects(agent.evaluate(request), /not idle/);
      assert.equal(
        launches(),
        1,
        "non-success must not trigger an implicit retry",
      );
    });
  }
}

test("retained harness receives exact current-turn publication context without a relaunch", async (t) => {
  const { agent, request, events, launches } = adapter(t);
  for (const date of ["2026-09-21T14:00:00.000Z", "2026-09-21T14:01:00.000Z"]) {
    events.length = 0;
    await agent.evaluate({
      ...request,
      prompt: "turn-context",
      chat: { ...request.chat, message_date: date },
    });
    const summary = events.find((e) => e.type === "summary");
    assert.deepEqual(JSON.parse(summary.finalResponse), {
      project_id: request.project_id,
      path: request.chat.path,
      thread_id: request.chat.thread_id,
      message_date: date,
    });
  }
  assert.equal(launches(), 1);
  assert.equal(request.chat.message_date, undefined);
});

test("harness context preserves user input and does not invent missing attribution", () => {
  const request = {
    project_id: "project",
    prompt: "Please publish my report.",
    chat: {
      path: 'a"\n.chat',
      thread_id: "thread",
      message_date: "2026-09-21T14:00:00.000Z",
    },
  };
  const prompt = harnessPrompt(request);
  assert.ok(prompt.endsWith("\n\n" + request.prompt));
  assert.ok(
    prompt.includes(JSON.stringify({ project_id: "project", ...request.chat })),
  );
  assert.ok(
    prompt.includes('"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"'),
  );
  assert.ok(prompt.includes("not an authorization grant"));
  assert.equal(harnessPrompt({ ...request, prompt: "/compact" }), "/compact");
  assert.equal(harnessPrompt({ ...request, chat: undefined }), request.prompt);
  assert.equal(
    harnessPrompt({
      ...request,
      chat: { ...request.chat, message_date: undefined },
    }),
    request.prompt,
  );
});

test("agent adapter preserves permission policy events and cancellation stop reason", async (t) => {
  const { agent, request, events } = adapter(t);
  await agent.evaluate({ ...request, prompt: "permission" });
  assert.ok(events.some((event) => event.event?.kind === "permission"));
  events.length = 0;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const run = agent.evaluate({
    ...request,
    prompt: "hang",
    stream: async (event) => {
      events.push(event);
      if (event.event?.type === "message") started();
    },
  });
  const rejected = assert.rejects(run, /cancelled/);
  await ready;
  assert.equal(await agent.interruptOutstanding("other"), false);
  assert.equal(await agent.interruptOutstanding("fixture-session"), true);
  await rejected;
  assert.ok(
    events.some((event) => event.event?.data?.stopReason === "cancelled"),
  );
  assert.ok(!events.some((event) => event.type === "summary"));
});
test("normal completion after interruption is uncertain, not a successful summary", async (t) => {
  const { agent, request, events } = adapter(t, ["--cancel-as-completed"]);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const run = agent.evaluate({
    ...request,
    prompt: "hang",
    stream: async (event) => {
      events.push(event);
      if (event.event?.type === "message") started();
    },
  });
  const rejected = assert.rejects(run, (error) => {
    assert.equal(error.code, "outcome_unknown");
    assert.match(error.message, /cancellation was not confirmed/);
    return true;
  });
  await ready;
  assert.equal(await agent.interruptOutstanding("fixture-session"), true);
  await rejected;
  assert.ok(
    events.some((event) => event.event?.data?.stopReason === "end_turn"),
  );
  assert.ok(!events.some((event) => event.type === "summary"));
  await assert.rejects(agent.evaluate(request), /not idle/);
});

test("interruption before prompt submission does not send inference", async (t) => {
  const { agent, request, events, stops } = adapter(t);
  await assert.rejects(
    agent.evaluate({
      ...request,
      stream: async (event) => {
        events.push(event);
        if (event.type === "status" && event.state === "running")
          assert.equal(
            await agent.interruptOutstanding("fixture-session"),
            true,
          );
      },
    }),
    /interrupted before submission/,
  );
  assert.ok(!events.some((event) => event.event?.type === "message"));
  assert.ok(!events.some((event) => event.type === "summary"));
  assert.equal(stops(), 1);
});

test("interruption during attention finalization cannot publish success", async (t) => {
  const { agent, request, events, stops } = adapter(t, [], {
    requestSyncQuestion: async () => ({}),
    runtimeClosed: async (context) => {
      if (context) await agent.interruptOutstanding("fixture-session");
    },
  });
  await assert.rejects(agent.evaluate(request), { code: "outcome_unknown" });
  assert.ok(!events.some((event) => event.type === "summary"));
  assert.equal(stops(), 1);
});

async function start(
  t,
  args = [],
  questionHandler,
  nodeArgs = [],
  onExit,
  beforeStop,
) {
  let child;
  const client = await AcpHarnessClient.start(
    {
      projectId: "project-a",
      accountId: "account-a",
      profile: { ...profile, args: [...nodeArgs, ...profile.args, ...args] },
    },
    async ({ profile }) => {
      child = spawn(profile.executable, profile.args, {
        cwd: profile.cwd,
        env: {},
        stdio: "pipe",
      });
      if (onExit)
        child.once("exit", (code, signal) => onExit({ code, signal }));
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
          await beforeStop?.();
          child.kill("SIGKILL");
          await closed;
        },
      };
    },
    1500,
    questionHandler,
  );
  t.after(() => client.dispose());
  return client;
}
test("failed process cleanup can be retried without reusing the disposed client", async (t) => {
  let attempts = 0;
  const client = await start(t, [], undefined, [], undefined, async () => {
    if (++attempts === 1) throw Error("Temporary removal failure");
  });
  await client.open();
  await assert.rejects(client.dispose(), /Temporary removal failure/);
  await assert.rejects(
    client.prompt("hello", async () => {}),
    { code: "unavailable" },
  );
  const retry = client.dispose();
  assert.equal(
    client.dispose(),
    retry,
    "concurrent cleanup shares one attempt",
  );
  await retry;
  assert.equal(attempts, 2);
  await client.dispose();
  assert.equal(attempts, 2, "successful cleanup remains idempotent");
});
test("ACP task questions use the registered handler and exact schema response", async (t) => {
  let called = 0;
  const client = await start(t, [], async (questions, signal) => {
    called++;
    assert.equal(questions[0].id, "target");
    assert.equal(signal.aborted, false);
    return { target: { answers: ["local"] } };
  });
  await client.open();
  const chunks = [];
  await client.prompt("question", async (e) => {
    if (e.type === "message") chunks.push(e.text);
  });
  assert.deepEqual(JSON.parse(chunks.join("")), {
    action: "accept",
    content: { target: "local" },
  });
  await client.prompt("question-wrong-session", async () => {});
  assert.equal(called, 1);
});
test("cancel aborts pending ACP task questions and ignores late answers", async (t) => {
  let questionSignal, answer;
  let ready;
  const entered = new Promise((resolve) => (ready = resolve));
  const client = await start(t, [], async (_questions, signal) => {
    questionSignal = signal;
    ready();
    return new Promise((resolve) => (answer = resolve));
  });
  await client.open();
  const pending = client.prompt("question", async () => {});
  await entered;
  await client.cancel();
  assert.equal(questionSignal.aborted, true);
  await pending;
  answer({ target: { answers: ["staging"] } });
  assert.equal(client.running, false);
});
test("unavailable ACP question callbacks fail explicitly instead of hanging", async (t) => {
  const client = await start(t);
  await client.open();
  const chunks = [];
  await client.prompt("question", async (e) => {
    if (e.type === "message") chunks.push(e.text);
  });
  assert.deepEqual(JSON.parse(chunks.join("")), { rejected: true });
});
for (const lateResult of ["answer", "rejection"]) {
  test(
    `late ${lateResult} from a cancelled question cannot affect a new pending question`,
    { timeout: 10000 },
    async (t) => {
      const waiting = [];
      const entered = [Promise.withResolvers(), Promise.withResolvers()];
      const client = await start(t, [], async (_questions, signal) => {
        const deferred = Promise.withResolvers();
        const index = waiting.length;
        waiting.push({ ...deferred, signal });
        entered[index].resolve();
        return deferred.promise;
      });
      await client.open();
      const first = client.prompt("question", async () => {});
      await entered[0].promise;
      await client.cancel();
      await first;
      assert.equal(waiting[0].signal.aborted, true);

      const chunks = [];
      const second = client.prompt("question", async (event) => {
        if (event.type === "message") chunks.push(event.text);
      });
      await entered[1].promise;
      if (lateResult === "answer") {
        waiting[0].resolve({ target: { answers: ["local"] } });
      } else {
        waiting[0].reject(Error("Old question failed after interruption"));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waiting[1].signal.aborted, false);
      assert.equal(client.running, true);
      waiting[1].resolve({ target: { answers: ["staging"] } });
      await second;
      assert.equal(waiting.length, 2);
      assert.deepEqual(JSON.parse(chunks.join("")), {
        action: "accept",
        content: { target: "staging" },
      });
    },
  );
}
for (const failure of ["handler rejection", "invalid answer"]) {
  test(`${failure} releases the question slot for a valid follow-up`, async (t) => {
    let calls = 0;
    const client = await start(t, [], async () => {
      calls++;
      if (calls === 1) {
        if (failure === "handler rejection")
          throw Error("Private handler detail");
        return { target: { answers: ["not-an-option"] } };
      }
      return { target: { answers: ["staging"] } };
    });
    await client.open();
    const rejected = [];
    await client.prompt("question", async (event) => {
      if (event.type === "message") rejected.push(event.text);
    });
    assert.deepEqual(JSON.parse(rejected.join("")), { rejected: true });
    const accepted = [];
    await client.prompt("question", async (event) => {
      if (event.type === "message") accepted.push(event.text);
    });
    assert.equal(calls, 2);
    assert.deepEqual(JSON.parse(accepted.join("")), {
      action: "accept",
      content: { target: "staging" },
    });
  });
}

test("disposing a waiting question aborts its handler and rejects session reuse", async (t) => {
  let ready, answer, questionSignal;
  const entered = new Promise((resolve) => (ready = resolve));
  const client = await start(t, [], async (_questions, signal) => {
    questionSignal = signal;
    ready();
    return new Promise((resolve) => (answer = resolve));
  });
  await client.open();
  const pending = assert.rejects(
    client.prompt("question", async () => {}),
    {
      code: "outcome_unknown",
    },
  );
  await entered;
  await client.dispose();
  assert.equal(questionSignal.aborted, true);
  await pending;
  answer({ target: { answers: ["local"] } });
  await assert.rejects(
    client.prompt("question", async () => {}),
    {
      code: "unavailable",
    },
  );
});

for (const variant of ["optional", "pattern", "boolean"]) {
  test(`unsupported ${variant} form never opens QA and leaves valid follow-up usable`, async (t) => {
    let questions = 0;
    const client = await start(t, [], async () => {
      questions++;
      return { target: { answers: ["local"] } };
    });
    await client.open();
    const rejected = [];
    await client.prompt(`question-${variant}`, async (event) => {
      if (event.type === "message") rejected.push(event.text);
    });
    assert.deepEqual(JSON.parse(rejected.join("")), { rejected: true });
    assert.equal(questions, 0);
    assert.equal(client.running, false);
    const accepted = [];
    await client.prompt("question", async (event) => {
      if (event.type === "message") accepted.push(event.text);
    });
    assert.equal(questions, 1);
    assert.deepEqual(JSON.parse(accepted.join("")), {
      action: "accept",
      content: { target: "local" },
    });
  });
}
test("advertised grouped config options apply before inference and survive follow-up", async (t) => {
  const client = await start(t, ["--config-options"]);
  await client.open();
  assert.deepEqual(client.controls.configOptions[0].options, [
    { value: "fast", name: "Fast" },
    { value: "deep", name: "Deep" },
  ]);
  await assert.rejects(
    client.configure({ configOptions: [{ id: "model", value: "invented" }] }),
    { code: "unsupported" },
  );
  await client.configure({ configOptions: [{ id: "model", value: "deep" }] });
  const events = [];
  await client.prompt("settings", async (event) => {
    events.push(event);
  });
  assert.equal(events[0].text, "deep/code");
  assert.equal(client.controls.configOptions[0].currentValue, "deep");
  const clone = client.controls;
  clone.configOptions[0].options.length = 0;
  assert.equal(client.controls.configOptions[0].options.length, 2);
});

test("legacy modes are session-scoped and cannot change during a prompt", async (t) => {
  const client = await start(t, ["--modes"]);
  await client.open("fixture-session");
  await client.configure({ modeId: "plan" });
  assert.equal(client.controls.mode.currentValue, "plan");
  let ready;
  const started = new Promise((resolve) => (ready = resolve));
  const run = client.prompt("hang", async () => ready());
  await started;
  await assert.rejects(client.configure({ modeId: "code" }), {
    code: "unavailable",
  });
  await client.cancel();
  await run;
  assert.equal(client.controls.mode.currentValue, "plan");
});

test("unconfirmed model selection prevents inference and closes the adapter", async (t) => {
  const { agent, request, events, launches, stops } = adapter(t, [
    "--config-options",
    "--ignore-config",
  ]);
  await assert.rejects(
    agent.evaluate({
      ...request,
      runtime: {
        version: 1,
        kind: "acp",
        profile,
        settings: { configOptions: [{ id: "model", value: "deep" }] },
      },
    }),
    (error) => {
      assert.equal(error.code, "rejected");
      assert.match(error.message, /did not apply/);
      return true;
    },
  );
  assert.equal(launches(), 1);
  assert.equal(stops(), 1);
  assert.ok(
    !events.some(
      (event) => event.type === "summary" || event.event?.type === "message",
    ),
  );
  await assert.rejects(agent.evaluate(request), /not idle/);
  assert.equal(launches(), 1);
});

test("unsupported controls are not silently accepted", async (t) => {
  const client = await start(t);
  await client.open();
  assert.deepEqual(client.controls, { configOptions: [] });
  await assert.rejects(client.configure({ modeId: "plan" }), {
    code: "unsupported",
  });
  await assert.rejects(
    client.configure({ configOptions: [{ id: "model", value: "deep" }] }),
    { code: "unsupported" },
  );
});

test("a later model change cannot silently reset an earlier admitted choice", async (t) => {
  const { agent, request, events, stops } = adapter(t, [
    "--config-options",
    "--dependent-config",
  ]);
  await assert.rejects(
    agent.evaluate({
      ...request,
      runtime: {
        version: 1,
        kind: "acp",
        profile,
        settings: {
          configOptions: [
            { id: "thinking", value: "high" },
            { id: "model", value: "deep" },
          ],
        },
      },
    }),
    { code: "rejected" },
  );
  assert.equal(stops(), 1);
  assert.ok(
    !events.some(
      (event) => event.type === "summary" || event.event?.type === "message",
    ),
  );
});

test("dependent choices work when the final catalog retains the entire selection", async (t) => {
  const client = await start(t, ["--config-options", "--dependent-config"]);
  await client.open();
  await client.configure({
    configOptions: [
      { id: "model", value: "deep" },
      { id: "thinking", value: "high" },
    ],
  });
  assert.deepEqual(
    client.controls.configOptions.map(({ id, currentValue }) => [
      id,
      currentValue,
    ]),
    [
      ["thinking", "high"],
      ["model", "deep"],
    ],
  );
  const result = await client.prompt("hi", async () => {});
  assert.equal(result.stopReason, "end_turn");
});

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
for (const variant of ["deny-only", "persistent-only", "wrong-session"]) {
  test(`permission ${variant} is cancelled without breaking the next prompt`, async (t) => {
    const client = await start(t);
    await client.open();
    const events = [];
    const response = await client.prompt(`permission-${variant}`, async (e) => {
      events.push(e);
    });
    assert.equal(response.stopReason, "end_turn");
    assert.deepEqual(JSON.parse(events.at(-1).text), {
      outcome: { outcome: "cancelled" },
    });
    assert.ok(
      !events.some((e) => e.type === "permission" && e.outcome === "allowed"),
    );
    if (variant === "wrong-session") {
      assert.ok(!events.some((e) => e.type === "permission"));
    }
    const followup = [];
    await client.prompt("hello", async (e) => followup.push(e));
    assert.equal(followup.map((e) => e.text ?? "").join(""), "Hello world 1");
  });
}

for (const callback of [
  "terminal",
  "terminal-output",
  "terminal-release",
  "terminal-wait",
  "terminal-kill",
  "file-read",
  "file-write",
]) {
  test(`unadvertised ${callback} callback fails explicitly and leaves the session usable`, async (t) => {
    const client = await start(t);
    await client.open();
    const events = [];
    await client.prompt(`unsupported-${callback}`, async (e) => events.push(e));
    const error = JSON.parse(events.at(-1).text);
    assert.equal(error.code, -32601);
    const followup = [];
    await client.prompt("hello", async (e) => followup.push(e));
    assert.equal(followup.map((e) => e.text ?? "").join(""), "Hello world 1");
  });
}

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
for (const [flag, code] of [
  ["--reject-resume", "rejected"],
  ["--crash-resume", "unavailable"],
]) {
  test(`${flag} discards replay and closes the adapter without fallback`, async (t) => {
    const { agent, request, events, launches, stops } = adapter(t, [flag]);
    await assert.rejects(
      agent.evaluate({ ...request, session_id: "fixture-session" }),
      (error) => {
        assert.equal(error.code, code);
        assert.ok(!error.message.includes("private fixture resume detail"));
        return true;
      },
    );
    assert.equal(launches(), 1);
    assert.equal(stops(), 1);
    assert.ok(!events.some((event) => event.type === "summary"));
    assert.ok(!events.some((event) => event.event?.type === "message"));
    await assert.rejects(agent.evaluate(request), /not idle/);
    assert.equal(launches(), 1);
  });
}
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
test("bounded harness heap exhaustion preserves partial output and prevents reuse", async (t) => {
  let observeExit;
  const exited = new Promise((resolve) => {
    observeExit = resolve;
  });
  const client = await start(
    t,
    [],
    undefined,
    ["--max-old-space-size=32", "--max-semi-space-size=1"],
    observeExit,
  );
  await client.open();
  const events = [];
  await assert.rejects(
    client.prompt("heap-exhaustion", async (event) => events.push(event)),
    (error) => {
      assert.equal(error.code, "outcome_unknown");
      assert.ok(!error.message.includes("FATAL ERROR"));
      return true;
    },
  );
  assert.deepEqual(
    events.filter((e) => e.type === "message").map((e) => e.text),
    ["working before heap exhaustion"],
  );
  assert.equal((await exited).signal, "SIGABRT");
  await assert.rejects(
    client.prompt("hi", async () => {}),
    { code: "unavailable" },
  );
});

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
test(
  "disk-full persistence preserves saved output and prevents session reuse",
  { skip: process.platform !== "linux", timeout: 10000 },
  async (t) => {
    const {
      mkdtemp,
      open,
      readFile,
      rm,
      writeFile,
    } = require("node:fs/promises");
    const { tmpdir } = require("node:os");
    const root = await mkdtemp(path.join(tmpdir(), "acp-persistence-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    // Linux's full device produces a real ENOSPC without filling any disk.
    const full = await open("/dev/full", "w");
    t.after(() => full.close());
    const saved = path.join(root, "output");
    const client = await start(t);
    await client.open();
    let chunks = 0;
    let storageError;
    await assert.rejects(
      client.prompt("hi", async (event) => {
        if (event.type !== "message") return;
        if (++chunks === 1) {
          await writeFile(saved, event.text);
          return;
        }
        try {
          await full.write(event.text);
        } catch (error) {
          storageError = error;
          throw error;
        }
      }),
      (error) =>
        error.code === "outcome_unknown" &&
        !error.message.includes(root) &&
        !error.message.includes("/dev/full"),
    );
    assert.equal(storageError?.code, "ENOSPC");
    assert.equal(chunks, 2);
    assert.equal(await readFile(saved, "utf8"), "Hello ");
    await assert.rejects(
      client.prompt("hi", async () =>
        assert.fail("dead session emitted output"),
      ),
      { code: "unavailable" },
    );
  },
);
test("protocol mismatch fails closed", async (t) => {
  await assert.rejects(
    start(t, ["--wrong-version"]),
    (e) => e.code === "unsupported",
  );
});
test("startup has a timeout, not an unlimited wait", async (t) => {
  await assert.rejects(start(t, ["--hang"]), (e) => e.code === "unavailable");
});

test(
  "quiet prompts and idle sessions outlast the setup timeout",
  { timeout: 15000 },
  async (t) => {
    const client = await start(t);
    await client.open();
    const sessionId = client.sessionId;
    const events = [];
    const started = performance.now();
    const result = await client.prompt("quiet", async (e) => events.push(e));
    assert.ok(performance.now() - started >= 3000);
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(
      events.map((e) => e.text),
      ["Quiet turn completed."],
    );
    // start() uses a 1500ms setup timeout, not a prompt or idle deadline.
    await new Promise((resolve) => setTimeout(resolve, 1700));
    events.length = 0;
    await client.prompt("hi", async (e) => events.push(e));
    assert.equal(client.sessionId, sessionId);
    assert.deepEqual(
      events.map((e) => e.text),
      ["Hello ", "world 1"],
    );
  },
);

test(
  "large stderr output is drained separately without poisoning reuse",
  { timeout: 10000 },
  async (t) => {
    const client = await start(t);
    await client.open();
    const events = [];
    const result = await client.prompt("stderr-flood", async (e) =>
      events.push(e),
    );
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(
      events.map((e) => e.text),
      ["Diagnostics drained."],
    );
    await client.prompt("hi", async (e) => events.push(e));
    assert.deepEqual(
      events.map((e) => e.text),
      ["Diagnostics drained.", "Hello ", "world 1"],
    );
  },
);

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
