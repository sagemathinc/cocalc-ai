import { OUCH_FORMATS } from "@cocalc/conat/files/fs";
import { file_associations } from "./file-associations";

describe("archive file associations", () => {
  it("opens every compress UI format in the archive editor", () => {
    for (const format of OUCH_FORMATS) {
      const ext = format.split(".").at(-1);
      expect(ext).toBeTruthy();
      expect(file_associations[ext!]?.editor).toBe("archive");
    }
  });

  it("opens tar.lz4 files in the archive editor", () => {
    expect(file_associations.lz4?.editor).toBe("archive");
  });
});
