import {
  CURRENT_DOCUMENT_SCHEMA_VERSION,
  isLegacyDocumentSchemaVersion,
  legacyEscapedMathDelimitersToText,
  normalizeLegacyTextElement,
} from "./document-schema";

describe("whiteboard document schema compatibility", () => {
  it("treats missing and pre-v1 schema versions as legacy", () => {
    expect(isLegacyDocumentSchemaVersion(undefined)).toBe(true);
    expect(isLegacyDocumentSchemaVersion(0)).toBe(true);
    expect(isLegacyDocumentSchemaVersion(CURRENT_DOCUMENT_SCHEMA_VERSION)).toBe(
      false,
    );
  });

  it("turns legacy escaped math delimiters back into literal punctuation", () => {
    expect(
      legacyEscapedMathDelimitersToText(
        String.raw`Title \(the slide\) and \[not math\]`,
      ),
    ).toBe("Title (the slide) and [not math]");
  });

  it("normalizes only legacy text element strings", () => {
    expect(
      normalizeLegacyTextElement({
        id: "text",
        type: "text",
        str: String.raw`See \(this\)`,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        z: 0,
      }).str,
    ).toBe("See (this)");

    const pen = {
      id: "pen",
      type: "pen" as const,
      str: String.raw`See \(this\)`,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      z: 0,
    };
    expect(normalizeLegacyTextElement(pen)).toBe(pen);
  });
});
