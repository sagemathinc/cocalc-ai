import { resolveMarkdownClipboardPayload } from "../editable-markdown";

describe("resolveMarkdownClipboardPayload", () => {
  it("ignores cached markdown when plain-text paste is forced", () => {
    expect(
      resolveMarkdownClipboardPayload({
        plain: "- x",
        markdown: "",
        tagged: "",
        cached: { text: "- x", at: 1000 },
        now: 2000,
        forcePlainTextPaste: true,
      }),
    ).toBeNull();
  });

  it("ignores explicit markdown payloads when plain-text paste is forced", () => {
    expect(
      resolveMarkdownClipboardPayload({
        plain: "**bold**",
        markdown: "**bold**",
        tagged: "",
        cached: null,
        forcePlainTextPaste: true,
      }),
    ).toBeNull();
  });
});
