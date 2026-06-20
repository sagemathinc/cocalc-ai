import { OUCH_FORMATS } from "@cocalc/conat/files/fs";
import { ARCHIVE_EXTENSIONS, COMMANDS, DOUBLE_EXT } from "./misc";

describe("archive editor ouch format support", () => {
  it("has list and extract commands for every compress UI format", () => {
    for (const format of OUCH_FORMATS) {
      expect(COMMANDS[format]?.list).toBeDefined();
      expect(COMMANDS[format]?.extract).toBeDefined();
    }
  });

  it("registers final extensions for multi-part ouch archive names", () => {
    expect(ARCHIVE_EXTENSIONS).toContain("lz4");
    expect(ARCHIVE_EXTENSIONS).toContain("zst");
    expect(ARCHIVE_EXTENSIONS).toContain("br");
    expect(ARCHIVE_EXTENSIONS).toContain("7z");
  });

  it("recognizes multi-part ouch archive suffixes", () => {
    expect(DOUBLE_EXT).toContain("tar.lz4");
    expect(DOUBLE_EXT).toContain("tar.zst");
    expect(DOUBLE_EXT).toContain("tar.br");
  });
});
