import {
  getQueuedMessageEditHelpText,
  resolveEditedMessageForSave,
  shouldShowQueuedMessageEditedVersionSent,
} from "../message-state";

describe("resolveEditedMessageForSave", () => {
  it("prefers non-empty mention-substituted text", () => {
    expect(
      resolveEditedMessageForSave("from-mentions", "submitted", "edited"),
    ).toBe("from-mentions");
  });

  it("falls back to submitted value when mention substitution is empty", () => {
    expect(resolveEditedMessageForSave("", "submitted", "edited")).toBe(
      "submitted",
    );
  });

  it("falls back to edited value when submitted is undefined", () => {
    expect(resolveEditedMessageForSave("", undefined, "edited")).toBe("edited");
  });

  it("shows queued edit feedback only for queued messages with saved history", () => {
    expect(
      shouldShowQueuedMessageEditedVersionSent({
        acpStateToRender: "queue",
        historySize: 2,
      }),
    ).toBe(true);
    expect(
      shouldShowQueuedMessageEditedVersionSent({
        acpStateToRender: "queue",
        historySize: 1,
      }),
    ).toBe(false);
    expect(
      shouldShowQueuedMessageEditedVersionSent({
        acpStateToRender: "running",
        historySize: 2,
      }),
    ).toBe(false);
  });

  it("shows queued edit help text only while editing a queued message", () => {
    expect(
      getQueuedMessageEditHelpText({
        acpStateToRender: "queue",
        isEditing: true,
      }),
    ).toBe(
      "If you edit and save this message before the next turn, then it will be used.",
    );
    expect(
      getQueuedMessageEditHelpText({
        acpStateToRender: "queue",
        isEditing: false,
      }),
    ).toBeUndefined();
    expect(
      getQueuedMessageEditHelpText({
        acpStateToRender: "running",
        isEditing: true,
      }),
    ).toBeUndefined();
  });
});
