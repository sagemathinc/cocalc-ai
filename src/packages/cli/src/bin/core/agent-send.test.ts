import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { agentSendExitCode, agentSendSummary } from "./agent-send";

const target = { project_id: randomUUID(), agent_id: randomUUID() };
const base = {
  version: 3 as const,
  attempt_id: randomUUID(),
  agent_network_id: randomUUID(),
  target,
  observed_at: Date.now(),
};
const sent = (outcome: any) => ({
  outcome: { ...base, ...outcome },
  target_name: "reviewer",
  project_title: "Support",
  agent_network_title: "cocalc",
});

test("the summary says what happened and where a reply arrives", () => {
  const accepted = agentSendSummary(
    sent({ outcome: "accepted", chat_effect: "saved" }),
  );
  assert.match(
    accepted,
    /^Delivered to @reviewer \(Support\) via Agent Network "cocalc"/,
  );
  assert.match(accepted, /not finished/);
  assert.match(accepted, /new message in your thread/);
  assert.match(
    agentSendSummary(
      sent({
        outcome: "accepted",
        operation: { id: "x", disposition: "queued" },
      }),
    ),
    /queued behind their current work/,
  );
  assert.match(
    agentSendSummary(
      sent({
        outcome: "rejected",
        reason: "Project is stopped",
        chat_effect: "none",
      }),
    ),
    /^Not delivered to @reviewer .*: Project is stopped\. Nothing was saved\.$/,
  );
  const unknown = agentSendSummary(
    sent({ outcome: "unknown", reason: "timeout" }),
  );
  assert.match(unknown, /unconfirmed: timeout/);
  assert.match(unknown, /do not resend automatically/);
  assert.ok(unknown.includes(`agent rpc inspect ${base.attempt_id}`));
  assert.ok(unknown.includes(`--to-agent ${target.agent_id}`));
});

test("exit codes distinguish accepted, rejected and unknown", () => {
  assert.equal(agentSendExitCode("accepted"), 0);
  assert.equal(agentSendExitCode("rejected"), 2);
  assert.equal(agentSendExitCode("unknown"), 3);
});

test("external inboxes and external senders get accurate summaries", () => {
  const external = {
    kind: "external" as const,
    account_id: randomUUID(),
    agent_id: randomUUID(),
    installation_id: randomUUID(),
  };
  const inbox = agentSendSummary({
    ...sent({ outcome: "accepted", chat_effect: "saved" }),
    outcome: {
      ...base,
      target: external,
      outcome: "accepted",
      chat_effect: "saved",
    },
  } as any);
  assert.match(inbox, /saved in their external inbox\. No turn starts/);
  assert.doesNotMatch(inbox, /turn was started/);
  const unknown = agentSendSummary({
    ...sent({ outcome: "unknown", reason: "timeout" }),
    external_agent: "laptop",
  });
  assert.ok(unknown.includes('--external-agent "laptop".'));
});
