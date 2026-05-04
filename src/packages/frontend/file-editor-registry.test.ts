import {
  getFileEditorRegistryState,
  markEditorExtensionRegistered,
  resetFileEditorRegistryForTests,
  wasEditorExtensionRegistered,
} from "./file-editor-registry";

describe("file editor registry state", () => {
  beforeEach(() => {
    resetFileEditorRegistryForTests();
  });

  it("persists registry state on globalThis across repeated access", () => {
    const first = getFileEditorRegistryState();
    first.file_editors.chat = { component: "chat-editor" };
    first.altExt["project-path"] = "chat";

    const second = getFileEditorRegistryState();
    expect(second).toBe(first);
    expect(second.file_editors.chat).toEqual({ component: "chat-editor" });
    expect(second.altExt["project-path"]).toBe("chat");
  });

  it("remembers previously registered extensions", () => {
    expect(wasEditorExtensionRegistered("chat")).toBe(false);
    markEditorExtensionRegistered("chat");
    expect(wasEditorExtensionRegistered("chat")).toBe(true);
    expect(wasEditorExtensionRegistered("md")).toBe(false);
  });
});
