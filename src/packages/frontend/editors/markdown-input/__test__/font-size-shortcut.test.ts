import { matchFontSizeShortcut } from "../font-size-shortcut";

function event(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: "",
    code: "",
    ...partial,
  } as KeyboardEvent;
}

describe("matchFontSizeShortcut", () => {
  it("matches shrink shortcuts", () => {
    expect(
      matchFontSizeShortcut(event({ ctrlKey: true, shiftKey: true, key: "<" })),
    ).toBe(-1);
    expect(
      matchFontSizeShortcut(
        event({ metaKey: true, shiftKey: true, key: ",", code: "Comma" }),
      ),
    ).toBe(-1);
  });

  it("matches enlarge shortcuts", () => {
    expect(
      matchFontSizeShortcut(event({ ctrlKey: true, shiftKey: true, key: ">" })),
    ).toBe(1);
    expect(
      matchFontSizeShortcut(
        event({ metaKey: true, shiftKey: true, key: ".", code: "Period" }),
      ),
    ).toBe(1);
  });

  it("ignores plain punctuation and alt-modified shortcuts", () => {
    expect(matchFontSizeShortcut(event({ key: ">" }))).toBeUndefined();
    expect(
      matchFontSizeShortcut(
        event({ ctrlKey: true, shiftKey: true, altKey: true, key: ">" }),
      ),
    ).toBeUndefined();
  });
});
