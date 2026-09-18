// Test-only adapter around the real CLI transport. It never changes server code.
// Bundle built runtime modules, not workspace TypeScript path aliases.
// Run ncc from a directory outside the workspace after building the CLI.
const fs = require("node:fs");
const { mock } = require("node:test");
const transport = require("@cocalc/conat/core/client");
const {
  readIdentityCredential,
  sendIdentityMessage,
} = require("../dist/bin/core/agent-message");

async function run(args = process.argv.slice(2)) {
  const [
    sourceAgent,
    agentSession,
    targetProject,
    targetAgent,
    attemptId,
    evidence,
  ] = args;
  if (!evidence || args.length !== 6)
    throw Error(
      "Expected source-agent agent-session target-project target-agent attempt-id evidence-file",
    );
  const credential = await readIdentityCredential();
  if (credential.agent_id !== sourceAgent) throw Error("Wrong scoped QA agent");
  // Reserve the evidence file before sending. A repeated invocation fails here,
  // rather than replaying the same attempt after an observation failure.
  const fd = fs.openSync(evidence, "wx", 0o600);
  const record = (event, data) =>
    fs.writeSync(
      fd,
      JSON.stringify({ at: new Date().toISOString(), event, data }) + "\n",
    );
  let sends = 0;
  let dropped = false;
  const originalConnect = transport.connect;
  const patch = mock.method(transport, "connect", (options) => {
    const client = originalConnect(options);
    const request = client.request.bind(client);
    client.request = async (subject, body, options) => {
      if (body.action !== "send" || ++sends !== 1)
        throw Error("Unexpected QA transport operation");
      const response = await request(subject, body, options);
      const outcome = response.data?.result;
      if (
        outcome?.outcome === "accepted" &&
        outcome.attempt_id === attemptId &&
        outcome.target?.agent_id === targetAgent &&
        outcome.target?.project_id === targetProject
      ) {
        record("accepted-ack-discarded", outcome);
        dropped = true;
        throw Error(
          "QA transport adapter discarded the accepted acknowledgment",
        );
      }
      record("ack-not-discarded", outcome ?? { error: response.data?.error });
      return response;
    };
    return client;
  });
  try {
    record("begin", {
      sourceAgent,
      agentSession,
      targetProject,
      targetAgent,
      attemptId,
    });
    const result = await sendIdentityMessage({
      version: 3,
      action: "send",
      agent_session_id: agentSession,
      target: { project_id: targetProject, agent_id: targetAgent },
      attempt_id: attemptId,
      body: `Lost-ack QA ${attemptId}. Acknowledge this message locally only. Do not reply to any agent, execute commands, edit files, or change permissions.`,
    });
    record("sender-outcome", { result, sends, dropped });
    return {
      result,
      passed: dropped && sends === 1 && result.outcome === "unknown",
    };
  } finally {
    patch.mock.restore();
    fs.closeSync(fd);
  }
}
module.exports = { run };
if (require.main === module) {
  run()
    .then(({ result, passed }) => {
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!passed) process.exitCode = 2;
    })
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });
}
