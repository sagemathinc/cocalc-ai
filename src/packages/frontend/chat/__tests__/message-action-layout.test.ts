import { COLORS } from "@cocalc/util/theme";
import {
  getFocusMessageButtonStyle,
  SELECTABLE_MARKDOWN_STYLE,
} from "../message";
import {
  resolveMessageBodyMode,
  shouldAutoSelectMessageBody,
  shouldUseCodexSelectToolbar,
} from "../message-state";

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
        autoSelectMode: false,
        useCodexSelectToolbar: true,
      }),
    ).toBe("select");
    expect(
      resolveMessageBodyMode({
        isEditing: true,
        selectMode: true,
        autoSelectMode: true,
        useCodexSelectToolbar: true,
      }),
    ).toBe("edit");
    expect(
      resolveMessageBodyMode({
        isEditing: false,
        selectMode: true,
        autoSelectMode: false,
        useCodexSelectToolbar: false,
      }),
    ).toBe("static");
    expect(
      resolveMessageBodyMode({
        isEditing: false,
        selectMode: false,
        autoSelectMode: true,
        useCodexSelectToolbar: true,
      }),
    ).toBe("select");
  });

  it("auto-selects only the latest non-editing Codex message body", () => {
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
        effectiveGenerating: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: false,
        isLastMessageInThread: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
        effectiveGenerating: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: false,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
        effectiveGenerating: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: true,
        isEditing: true,
        showHistory: false,
        isViewersMessage: false,
        effectiveGenerating: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: true,
        isEditing: false,
        showHistory: true,
        isViewersMessage: false,
        effectiveGenerating: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: true,
        effectiveGenerating: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoSelectMessageBody({
        useCodexSelectToolbar: true,
        isLastMessageInThread: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
        effectiveGenerating: true,
      }),
    ).toBe(false);
  });

  it("keeps selectable markdown links visually link-colored", () => {
    expect(SELECTABLE_MARKDOWN_STYLE["--cocalc-slate-link"]).toBe(
      COLORS.ANTD_LINK_BLUE,
    );
  });
});
