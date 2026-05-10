import { COLORS } from "@cocalc/util/theme";
import {
  getFocusMessageButtonStyle,
  SELECTABLE_MARKDOWN_STYLE,
} from "../message";
import {
  resolveMessageBodyMode,
  shouldUseSelectableMessageBody,
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
        useSelectableMessageBody: true,
      }),
    ).toBe("select");
    expect(
      resolveMessageBodyMode({
        isEditing: true,
        useSelectableMessageBody: true,
      }),
    ).toBe("edit");
    expect(
      resolveMessageBodyMode({
        isEditing: false,
        useSelectableMessageBody: false,
      }),
    ).toBe("static");
  });

  it("uses selectable mode for non-viewer Codex message bodies", () => {
    expect(
      shouldUseSelectableMessageBody({
        useCodexSelectToolbar: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
      }),
    ).toBe(true);
    expect(
      shouldUseSelectableMessageBody({
        useCodexSelectToolbar: false,
        isEditing: false,
        showHistory: false,
        isViewersMessage: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSelectableMessageBody({
        useCodexSelectToolbar: true,
        isEditing: true,
        showHistory: false,
        isViewersMessage: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSelectableMessageBody({
        useCodexSelectToolbar: true,
        isEditing: false,
        showHistory: true,
        isViewersMessage: false,
      }),
    ).toBe(false);
    expect(
      shouldUseSelectableMessageBody({
        useCodexSelectToolbar: true,
        isEditing: false,
        showHistory: false,
        isViewersMessage: true,
      }),
    ).toBe(false);
  });

  it("keeps selectable markdown links visually link-colored", () => {
    expect(SELECTABLE_MARKDOWN_STYLE["--cocalc-slate-link"]).toBe(
      COLORS.ANTD_LINK_BLUE,
    );
  });
});
