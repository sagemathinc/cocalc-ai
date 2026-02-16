import { normalizeCpSourcePath } from "./copy-paths";

describe("normalizeCpSourcePath", () => {
  it("keeps absolute paths unchanged", () => {
    expect(normalizeCpSourcePath("/root/a.txt")).toBe("/root/a.txt");
  });

  it("keeps already prefixed relative paths unchanged", () => {
    expect(normalizeCpSourcePath("./a.txt")).toBe("./a.txt");
  });

  it("prefixes plain relative paths", () => {
    expect(normalizeCpSourcePath("a.txt")).toBe("./a.txt");
  });

  it("prefixes dash-leading relative paths", () => {
    expect(normalizeCpSourcePath("-weird-name.txt")).toBe("./-weird-name.txt");
  });
});

