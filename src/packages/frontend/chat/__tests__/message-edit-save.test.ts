import { resolveEditedMessageForSave } from "../message";

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
    expect(resolveEditedMessageForSave("", undefined, "edited")).toBe(
      "edited",
    );
  });
});

