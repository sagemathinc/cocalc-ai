import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  getFocusMessageButtonStyle,
  MESSAGE_ACTIONS_STYLE,
  safeRenderSyncdbGetOne,
  SELECTABLE_MARKDOWN_STYLE,
} from "../message";
import {
  resolveMessageBodyMode,
  shouldUseSelectableMessageBody,
  shouldUseCodexSelectToolbar,
} from "../message-state";

describe("message action layout", () => {
  it("keeps persistent message actions in normal flow at the lower left", () => {
    expect(MESSAGE_ACTIONS_STYLE.justifyContent).toBe("flex-start");
    expect(MESSAGE_ACTIONS_STYLE.position).toBeUndefined();
  });

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
      UI_COLORS.link,
    );
  });

  it("does not read render-time syncdb records before the syncdoc is ready", () => {
    const syncdb = {
      get_state: () => "loading",
      get_one: jest.fn(() => {
        throw Error("doc must be set");
      }),
    };

    expect(safeRenderSyncdbGetOne(syncdb, { event: "draft" })).toBeUndefined();
    expect(syncdb.get_one).not.toHaveBeenCalled();
  });

  it("treats render-time syncdb get_one throws as unavailable data", () => {
    const syncdb = {
      get_state: () => "ready",
      get_one: jest.fn(() => {
        throw Error("doc must be set");
      }),
    };

    expect(safeRenderSyncdbGetOne(syncdb, { event: "draft" })).toBeUndefined();
    expect(syncdb.get_one).toHaveBeenCalledWith({ event: "draft" });
  });
});
