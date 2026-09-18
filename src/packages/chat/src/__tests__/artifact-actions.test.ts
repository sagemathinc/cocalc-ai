import {
  proposedActionBase,
  validateProposedActions,
  validateActionDecisions,
} from "../artifact-actions";
import {
  artifactFeedbackPrompt,
  validateArtifactFeedback,
  publishArtifact,
} from "../artifacts";
const proposal = {
  id: "reply",
  title: "Reply to Alex",
  target: "Zendesk ticket 123",
  draft: "Please send the notebook name.",
};
test("validates bounded unique proposals and rejects forged approval status", () => {
  expect(validateProposedActions([proposal])).toEqual([proposal]);
  expect(() => validateProposedActions([proposal, proposal])).toThrow();
  expect(() =>
    validateProposedActions([{ ...proposal, outcome: "approved" }]),
  ).toThrow();
  expect(() =>
    validateProposedActions([{ ...proposal, draft: "x".repeat(8193) }]),
  ).toThrow();
  expect(proposedActionBase({ ...proposal, outcome: "succeeded" })).toBe(
    proposedActionBase(proposal),
  );
  expect(proposedActionBase({ ...proposal, draft: "Different" })).not.toBe(
    proposedActionBase(proposal),
  );
});
test("review preserves exact drafts without treating approval as execution", () => {
  const review = validateActionDecisions([
    { proposal, decision: "approve", comment: "Looks right" },
  ]);
  const feedback = validateArtifactFeedback({
    schema_version: 1,
    thread_id: "thread",
    artifact_id: "actions",
    title: "Replies",
    markdown: "",
    rendered_text: "",
    start: 0,
    end: 0,
    quote: "",
    action_review: review,
  });
  expect(feedback.action_review).toEqual(review);
  expect(artifactFeedbackPrompt(feedback)).toContain(
    "Approval is not execution",
  );
});
test("action publications preserve exact proposal snapshots", () => {
  const rows = new Map<string, any>();
  const key = (row) =>
    JSON.stringify([row.event, row.sender_id, row.thread_id]);
  const store = {
    get_one: (row) => rows.get(key(row)),
    set: (batch) => {
      for (const row of batch) rows.set(key(row), row);
    },
  };
  const input = {
    thread_id: "thread",
    artifact_id: "actions",
    message_id: "message",
    operation_id: "first",
    title: "Replies",
    markdown: "",
    actions: [proposal],
  };
  const first = publishArtifact(store, input);
  const next = publishArtifact(store, {
    ...input,
    base: first.base,
    operation_id: "second",
    actions: [{ ...proposal, draft: "Updated" }],
  });
  expect(first.publication.snapshot.actions).toEqual([proposal]);
  expect(next.base).not.toBe(first.base);
});
