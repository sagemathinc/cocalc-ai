import { mapTextOffset } from "../map-text-offset";

describe("mapTextOffset", () => {
  it("keeps a caret in front of text inserted exactly at it", () => {
    // Notebook cell: a collaborator's new line merged in where this user is
    // typing must not move the caret after it (CodeMirror 5 would).
    const prev = "# Agenda\n tk1n8q tk0n8q tk2n6";
    const next = "# Agenda\n tk1n8q tk0n8q tk2n6\n         tk4n7q";
    expect(mapTextOffset(prev, next, prev.length)).toBe(prev.length);
  });

  it("moves a caret past the rest of a word a collaborator extended", () => {
    expect(mapTextOffset("notes tk2n12", "notes tk2n12q tk3", 12)).toBe(13);
  });

  it("shifts a caret after a change before it", () => {
    expect(mapTextOffset("abc def", "xx abc def", 5)).toBe(8);
  });

  it("never moves a caret into a similar word", () => {
    const prev = "tk2n4q tk2n10q tk6n14q";
    const next = "tk2n4q tk3n2q tk2n10q tk2n1q tk6n14q tk2n24q";
    for (let offset = 0; offset <= prev.length; offset++) {
      const before = prev.slice(0, offset).split(" ").pop()!;
      expect(next.slice(0, mapTextOffset(prev, next, offset))).toMatch(
        new RegExp(`${before}$`),
      );
    }
  });

  it("maps within a small change to a large document", () => {
    const line = "some text that does not change\n";
    const prev = line.repeat(20_000) + "x" + line.repeat(20_000);
    const next = line.repeat(20_000) + "xy" + line.repeat(20_000);
    const offset = prev.length - 5;
    expect(mapTextOffset(prev, next, offset)).toBe(offset + 1);
    expect(mapTextOffset(prev, next, 10)).toBe(10);
  });
});
