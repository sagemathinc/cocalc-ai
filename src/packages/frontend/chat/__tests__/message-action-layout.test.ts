import {
  getFocusMessageButtonStyle,
  resolveMessageBodyMode,
  shouldUseCodexSelectToolbar,
} from "../message";

describe("message action layout", () => {
  it("does not vertically offset the focus icon button", () => {
    expect(getFocusMessageButtonStyle()).toEqual({
      color: expect.any(String),
      fontSize: "12px",
    });
    expect(getFocusMessageButtonStyle().marginTop).toBeUndefined();
  });

  it("uses the condensed select toolbar for Codex assistant output", () => {
    expect(
      shouldUseCodexSelectToolbar({
        isCodexThread: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCodexSelectToolbar({
        isCodexThread: false,
      }),
    ).toBe(false);
  });

  it("switches the message body into read-only select mode only when enabled", () => {
    expect(
      resolveMessageBodyMode({
        isEditing: false,
        selectMode: true,
        useCodexSelectToolbar: true,
      }),
    ).toBe("select");
    expect(
      resolveMessageBodyMode({
        isEditing: true,
        selectMode: true,
        useCodexSelectToolbar: true,
      }),
    ).toBe("edit");
    expect(
      resolveMessageBodyMode({
        isEditing: false,
        selectMode: true,
        useCodexSelectToolbar: false,
      }),
    ).toBe("static");
  });
});
