import type { AcpAttentionRecord } from "@cocalc/conat/ai/acp/types";
import { showAttentionInFooter } from "../attention-response-display";

const saved = {
  attention_id: "question-1",
  source_kind: "codex_sync_question",
  state: "pending",
  response_submitted_at: 123,
} as AcpAttentionRecord;

const display = (
  overrides: Partial<Parameters<typeof showAttentionInFooter>[0]> = {},
) =>
  showAttentionInFooter({
    record: saved,
    hasDraftResponse: false,
    projected: true,
    ownerActive: true,
    ownerExpanded: true,
    ...overrides,
  });

it.each(["pending", "answered", "declined"] as const)(
  "does not duplicate a durable %s answer below the activity, even after reload without drafts",
  (state) => {
    expect(display({ record: { ...saved, state } })).toBe(false);
    expect(display({ record: { ...saved, state }, ownerActive: false })).toBe(
      false,
    );
  },
);

it("leaves unanswered actionable questions visible when completed activity is hidden", () => {
  expect(
    display({
      record: { ...saved, response_submitted_at: undefined },
      projected: false,
      ownerActive: false,
      ownerExpanded: false,
    }),
  ).toBe(true);
});

it("hides a saved pending card with completed activity and restores legacy cards on expansion", () => {
  expect(
    display({ projected: false, ownerActive: false, ownerExpanded: false }),
  ).toBe(false);
  expect(
    display({ projected: false, ownerActive: false, ownerExpanded: true }),
  ).toBe(true);
});

it.each(["codex_sync_question", "codex_async_question"] as const)(
  "keeps %s delivery failures visible after reload with completed activity collapsed",
  (source_kind) => {
    const record = { ...saved, source_kind, state: "stale" as const };
    expect(display({ record })).toBe(true);
    expect(display({ record, ownerActive: false, ownerExpanded: false })).toBe(
      true,
    );
    expect(display({ record, ownerActive: false, ownerExpanded: true })).toBe(
      true,
    );
  },
);

it("fails open for recovery when the owning turn cannot be found", () => {
  expect(
    display({ record: { ...saved, state: "stale" }, ownerActive: undefined }),
  ).toBe(true);
});
