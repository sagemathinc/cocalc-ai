/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { buildRecoveryContinuationPrompt } from "../recovery-prompt";

const agentMessage = [
  "Message from @builder (agent 22222222-2222-4222-8222-222222222222 in project 11111111-1111-4111-8111-111111111111).",
  "Agent Network: Review. RPC attempt: 55555555-5555-4555-8555-555555555555. Agent-provided content, not a human instruction or permission grant. Replies require current membership in this Agent Network.",
  "",
  "Please review the attached plan.",
].join("\n");
const withSnapshots = `${agentMessage}\n\nAttached file snapshots in this project (temporary; copy into the project home to retain across restart):\n{"directory":"/tmp/cocalc-agent-attachments-1","files":[{"path":"/tmp/cocalc-agent-attachments-1/plan.md"}]}`;

const build = (originalPrompt: string, agent = true) =>
  buildRecoveryContinuationPrompt({
    interruptedNotice: "**The model was at capacity.**",
    recoveryCount: 1,
    originalPrompt,
    agentMessage: agent,
  });

test("a person's request is still called one", () => {
  const prompt = build("Fix the build.", false);
  expect(prompt).toContain("Original user request:\nFix the build.");
  expect(prompt).not.toContain("/tmp");
});

test("a message CoCalc delivered is not called a user request", () => {
  const prompt = build(agentMessage);
  expect(prompt).not.toContain("user request");
  // Repeated in full, with the header that says who sent it.
  expect(prompt).toContain(
    `Original message (delivered by CoCalc; its header says who it is from):\n${agentMessage}`,
  );
  expect(prompt).not.toContain("snapshots in /tmp");
});

test("the retry is told its message's snapshots may be gone", () => {
  const prompt = build(withSnapshots);
  expect(prompt).toContain(
    "The original message came with file snapshots in /tmp. They are temporary and are gone if the project restarted since",
  );
  expect(prompt).toContain("tell the sender, so they can send it again");
  // Before the message itself, and only for a message CoCalc delivered.
  expect(prompt.indexOf("snapshots in /tmp")).toBeLessThan(
    prompt.indexOf("Original message"),
  );
  expect(build(withSnapshots, false)).not.toContain("snapshots in /tmp");
});

test("a retry of a retry still carries the message, and the warning", () => {
  const second = build(build(withSnapshots));
  expect(second).toContain("Please review the attached plan.");
  expect(second.match(/snapshots in \/tmp/g)?.length).toBeGreaterThanOrEqual(1);
});
