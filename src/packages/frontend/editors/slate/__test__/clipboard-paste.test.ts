import { handleForcedPlainTextPaste } from "../clipboard";
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

describe("handleForcedPlainTextPaste", () => {
  it("sanitizes rich clipboard payloads down to plain text only", () => {
    const insertData = jest.fn();
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    const editor: any = {
      __forcePlainTextPaste: true,
      insertData,
    };
    const event: any = {
      clipboardData: {
        getData: (type: string) => {
          if (type === "text/plain") return "- a\n- b";
          if (type === "text/html") return "<ul><li>a</li><li>b</li></ul>";
          if (type === "application/x-slate-fragment") return "rich-fragment";
          return "";
        },
        types: ["text/plain", "text/html", "application/x-slate-fragment"],
      },
      preventDefault,
      stopPropagation,
    };

    expect(handleForcedPlainTextPaste({ editor, event })).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(editor.__forcePlainTextPaste).toBe(false);
    expect(insertData).toHaveBeenCalledTimes(1);

    const data = insertData.mock.calls[0][0];
    expect(data.getData("text/plain")).toBe("- a\n- b");
    expect(data.getData("text/html")).toBe("");
    expect(data.getData("application/x-slate-fragment")).toBe("");
    expect(data.types).toEqual(["text/plain"]);
  });

  it("clears the force flag even when plain text is missing", () => {
    const editor: any = {
      __forcePlainTextPaste: true,
      insertData: jest.fn(),
    };
    const event: any = {
      clipboardData: {
        getData: () => "",
        types: ["text/html"],
      },
      preventDefault: jest.fn(),
      stopPropagation: jest.fn(),
    };

    expect(handleForcedPlainTextPaste({ editor, event })).toBe(false);
    expect(editor.__forcePlainTextPaste).toBe(false);
    expect(editor.insertData).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
