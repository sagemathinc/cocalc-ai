import { isPartialUploadName, partialUploadPath } from "./partial-upload";

describe("partial upload names", () => {
  it("recognizes in-flight upload temp files", () => {
    expect(isPartialUploadName("DUE_DATE.txt.partialupload-7SFX86A7J5")).toBe(
      true,
    );
    expect(
      isPartialUploadName("Lab 2/DUE_DATE.txt.partialupload-KTGC9JBB9L"),
    ).toBe(true);
    expect(
      isPartialUploadName(partialUploadPath("a/b.ipynb", "23456789AB")),
    ).toBe(true);
  });

  it("ignores names that the uploader would never produce", () => {
    expect(isPartialUploadName("DUE_DATE.txt")).toBe(false);
    expect(isPartialUploadName("notes.partialupload-final")).toBe(false);
    // wrong length, or characters outside the uploader's alphabet
    expect(isPartialUploadName("a.txt.partialupload-7SFX86A7J")).toBe(false);
    expect(isPartialUploadName("a.txt.partialupload-7SFX86A7J55")).toBe(false);
    expect(isPartialUploadName("a.txt.partialupload-7sfx86a7j5")).toBe(false);
    expect(isPartialUploadName("a.txt.partialupload-7SFX86A7J0")).toBe(false);
    expect(isPartialUploadName(".partialupload-7SFX86A7J5")).toBe(false);
    expect(isPartialUploadName("a.partialupload-7SFX86A7J5/inner.txt")).toBe(
      false,
    );
  });
});
