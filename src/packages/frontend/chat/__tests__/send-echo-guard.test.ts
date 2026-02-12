import { shouldIgnoreSentEcho } from "../send-echo-guard";

describe("shouldIgnoreSentEcho", () => {
  it("ignores stale exact echo while composer is empty", () => {
    expect(
      shouldIgnoreSentEcho({
        suppress: { raw: "hello", trimmed: "hello", active: true },
        incoming: "hello",
        currentInput: "",
      }),
    ).toBe(true);
  });

  it("ignores stale trimmed echo while composer is empty", () => {
    expect(
      shouldIgnoreSentEcho({
        suppress: { raw: "hello", trimmed: "hello", active: true },
        incoming: "hello   ",
        currentInput: "",
      }),
    ).toBe(true);
  });

  it("does not ignore when incoming differs", () => {
    expect(
      shouldIgnoreSentEcho({
        suppress: { raw: "hello", trimmed: "hello", active: true },
        incoming: "hello world",
        currentInput: "",
      }),
    ).toBe(false);
  });

  it("does not ignore when composer already has content", () => {
    expect(
      shouldIgnoreSentEcho({
        suppress: { raw: "hello", trimmed: "hello", active: true },
        incoming: "hello",
        currentInput: "typing...",
      }),
    ).toBe(false);
  });
});

