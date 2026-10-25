/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  AttentionPanel,
  AttentionPanelButton,
  attentionPanelRecords,
  isFailedDelivery,
  isLateQuestion,
} from "../attention-panel";

// The card itself is tested on its own: here, what the panel does with it.
jest.mock("../codex-attention-card", () => ({
  CodexAttentionCard: ({ initialRecord, draft, onDraftChange }: any) => (
    <section
      aria-label={initialRecord.attention_id}
      data-codex-attention-id={initialRecord.attention_id}
      tabIndex={-1}
    >
      <input
        aria-label={`answer ${initialRecord.attention_id}`}
        value={draft?.other?.q ?? ""}
        onChange={(event) =>
          onDraftChange((current: any) => ({
            ...current,
            other: { q: event.target.value },
          }))
        }
      />
    </section>
  ),
}));

const record = (id: string, extra: object = {}) =>
  ({
    attention_id: id,
    state: "pending",
    source_kind: "codex_async_question",
    questions: [{ id: "q" }],
    ...extra,
  }) as any;

describe("the panel's requests", () => {
  it("lists open ones, answered-here ones until the log has them, and failed deliveries", () => {
    const records = [
      record("open"),
      record("answered", { response_submitted_at: "x", state: "resolved" }),
      record("here", { response_submitted_at: "x", state: "resolved" }),
      record("stale", { state: "stale", response_submitted_at: "x" }),
      record("in-log", { state: "stale", response_submitted_at: "x" }),
      // Its turn ended unanswered: still answerable, as a new message.
      record("late", { state: "stale", source_kind: "codex_sync_question" }),
    ];
    const drafts = {
      here: {
        selected: {},
        other: {},
        submitted: { answers: {}, declined: false },
      },
    };
    expect(
      attentionPanelRecords(records, drafts, new Set(["in-log"])).map(
        ({ attention_id }) => attention_id,
      ),
    ).toEqual(["open", "here", "stale", "late"]);
    // Waiting, not undelivered.
    expect(isLateQuestion(records[5])).toBe(true);
    expect(isFailedDelivery(records[5], new Set())).toBe(false);
  });
});

describe("the button", () => {
  it("says how many questions wait, and nothing when none do", () => {
    const onOpen = jest.fn();
    const { rerender } = render(
      <AttentionPanelButton
        open={[record("a"), record("b")]}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /2 requests wait/ }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.getByText("2 questions waiting")).toBeInTheDocument();
    rerender(
      <AttentionPanelButton
        open={[record("a", { source_kind: "approval", questions: [] })]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("1 waiting for you")).toBeInTheDocument();
    rerender(<AttentionPanelButton open={[]} onOpen={onOpen} />);
    expect(screen.queryByRole("button")).toBeNull();
    // An answer that did not reach the agent keeps a way back to it.
    rerender(
      <AttentionPanelButton
        open={[]}
        failed={[record("stale", { state: "stale" })]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("Answer not delivered")).toBeInTheDocument();
    // Open and undelivered together: all of them are counted.
    rerender(
      <AttentionPanelButton
        open={[record("a")]}
        failed={[record("stale", { state: "stale" })]}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("2 waiting for you")).toBeInTheDocument();
  });
});

describe("the panel", () => {
  it("lists every open request and keeps what was typed while hidden", () => {
    const props = {
      records: [record("first"), record("second")],
      projected: new Set<string>(),
      onClose: jest.fn(),
    };
    const { rerender } = render(<AttentionPanel {...props} open />);
    const panel = screen.getByRole("complementary", {
      name: "Waiting for you",
    });
    expect(within(panel).getByText("Waiting for you (2)")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("answer first"), {
      target: { value: "draft text" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Hide (what you typed is kept)" }),
    );
    expect(props.onClose).toHaveBeenCalled();
    rerender(<AttentionPanel {...props} open={false} />);
    expect(screen.queryByRole("complementary")).toBeNull();
    rerender(<AttentionPanel {...props} open />);
    expect(screen.getByLabelText("answer first")).toHaveValue("draft text");
    // Submitting one leaves the other: it is the records that decide.
    rerender(
      <AttentionPanel
        {...props}
        records={[
          record("first", { response_submitted_at: "x", state: "resolved" }),
          record("second"),
        ]}
        open
      />,
    );
    expect(screen.getByLabelText("answer second")).toBeInTheDocument();
  });

  it("counts an undelivered answer as waiting", () => {
    render(
      <AttentionPanel
        records={[
          record("stale", { state: "stale", response_submitted_at: "x" }),
        ]}
        projected={new Set()}
        onClose={jest.fn()}
        open
      />,
    );
    expect(screen.getByText("Waiting for you (1)")).toBeInTheDocument();
  });

  it("takes the keys when opened, and resizes with the arrow keys", () => {
    const props = {
      records: [record("first")],
      projected: new Set<string>(),
      onClose: jest.fn(),
    };
    const { rerender } = render(<AttentionPanel {...props} open={false} />);
    rerender(<AttentionPanel {...props} open />);
    const panel = screen.getByRole("complementary", {
      name: "Waiting for you",
    });
    expect(document.activeElement).toBe(panel);
    const handle = screen.getByRole("separator");
    expect(Number(handle.getAttribute("aria-valuemax"))).toBeGreaterThanOrEqual(
      Number(handle.getAttribute("aria-valuemin")),
    );
    const before = Number(handle.getAttribute("aria-valuenow"));
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before + 24);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(before - 56);
    // Never past the chat's width.
    for (let i = 0; i < 200; i++)
      fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(Number(handle.getAttribute("aria-valuenow"))).toBe(
      Number(handle.getAttribute("aria-valuemax")),
    );
  });

  it("opens at a request it is sent to", () => {
    const scroll = jest.fn();
    Element.prototype.scrollIntoView = scroll;
    render(
      <AttentionPanel
        records={[record("first"), record("second")]}
        projected={new Set()}
        onClose={jest.fn()}
        open
        focusAttentionId="second"
        focusToken={1}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: "second" }),
    );
    expect(scroll).toHaveBeenCalled();
  });
});
