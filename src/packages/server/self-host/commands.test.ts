import { resolveSelfHostCommandOutcome } from "./commands";

describe("resolveSelfHostCommandOutcome", () => {
  it("returns a successful result for completed commands", () => {
    expect(
      resolveSelfHostCommandOutcome({
        action: "stop",
        state: "done",
        result: { state: "off" },
        error: null,
      }),
    ).toEqual({
      kind: "success",
      result: { state: "off" },
    });
  });

  it("returns an error outcome for failed commands", () => {
    expect(
      resolveSelfHostCommandOutcome({
        action: "stop",
        state: "error",
        result: null,
        error: "boom",
      }),
    ).toEqual({
      kind: "error",
      error: "boom",
    });
  });

  it("treats sent delete commands as accepted", () => {
    expect(
      resolveSelfHostCommandOutcome({
        action: "delete",
        state: "sent",
        result: null,
        error: null,
      }),
    ).toEqual({
      kind: "promote-delete",
      result: { accepted: true, action: "delete" },
    });
  });

  it("keeps waiting for non-delete sent commands", () => {
    expect(
      resolveSelfHostCommandOutcome({
        action: "stop",
        state: "sent",
        result: null,
        error: null,
      }),
    ).toEqual({ kind: "wait" });
  });
});
