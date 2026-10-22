import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  agentRpcInspectSummary,
  agentRpcWithdrawSummary,
  agentSendExitCode,
  agentSendSummary,
} from "./agent-send";
import {
  agentRecipientSetupError,
  parseAgentRecipientSetup,
} from "@cocalc/conat/agents/rpc";

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
  // Its first word says it: never mistaken for "Delivered".
  assert.match(unknown, /^UNCONFIRMED: delivery to @reviewer .*\(timeout\)/);
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

test("a recipient with nothing to pay for turns gives a sentence to relay", () => {
  const setup = parseAgentRecipientSetup(
    agentRecipientSetupError("codex-connection"),
  );
  assert.equal(setup?.need, "codex-connection");
  const summary = agentSendSummary(
    sent({
      outcome: "rejected",
      code: "execution_not_allowed",
      reason: setup!.reason,
      chat_effect: "saved",
    }),
  );
  assert.match(
    summary,
    /^Not delivered to @reviewer \(Support\) via Agent Network "cocalc": the recipient agent has no ChatGPT plan or OpenAI API key connected/,
  );
  assert.match(summary, /choose Connect in its thread/);
  assert.match(summary, /saved in their thread, but no turn started\.$/);
});

test("agent rpc inspect says where the turn is when the recipient knows", () => {
  assert.equal(
    agentRpcInspectSummary({
      ...base,
      outcome: "accepted",
      turn: { state: "queued", queued_at: Date.parse("2026-10-19T05:00:00Z") },
    }),
    "Queued since 2026-10-19T05:00:00.000Z; it has not started.",
  );
  // Otherwise what the receipt says, without inviting a resend.
  assert.match(
    agentRpcInspectSummary({ ...base, outcome: "accepted" }),
    /^Admitted; the recipient's host has no record of its turn/,
  );
  assert.match(
    agentRpcInspectSummary({
      ...base,
      outcome: "unknown",
      reason: "No retained acceptance evidence",
    }),
    /do not resend automatically/,
  );
});

test("a withdrawal says whether an earlier attempt may already have acted", () => {
  const accepted = { ...base, outcome: "accepted" as const };
  assert.match(
    agentRpcWithdrawSummary(accepted),
    /^Withdrawn: the recipient will not run it/,
  );
  // Held after it started (a usage limit): only its continuation stops.
  const held = (tool_ran?: boolean) =>
    agentRpcWithdrawSummary({
      ...accepted,
      turn: {
        state: "ended",
        queued_at: Date.now() - 60_000,
        started_at: Date.now() - 50_000,
        ...(tool_ran !== undefined ? { tool_ran } : {}),
      },
    } as any);
  assert.match(
    held(true),
    /will not resume.*may have run tools: check what it did/,
  );
  assert.match(held(), /may have run tools/);
  assert.match(held(false), /it ran no tools/);
});
