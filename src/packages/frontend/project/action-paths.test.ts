import {
  moveDestinationPath,
  normalizeDirectoryDestination,
} from "./action-paths";

describe("normalizeDirectoryDestination", () => {
  it("keeps root unchanged", () => {
    expect(normalizeDirectoryDestination("/")).toBe("/");
  });

  it("adds trailing slash when missing", () => {
    expect(normalizeDirectoryDestination("/root/tmp")).toBe("/root/tmp/");
  });

  it("does not add duplicate trailing slash", () => {
    expect(normalizeDirectoryDestination("/root/tmp/")).toBe("/root/tmp/");
  });
});

describe("moveDestinationPath", () => {
  it("moves absolute source into absolute destination directory", () => {
    expect(moveDestinationPath("/root/out", "/tmp/a.txt")).toBe(
      "/root/out/a.txt",
    );
  });

  it("moves relative source into relative destination directory", () => {
    expect(moveDestinationPath("dest", "subdir/a.txt")).toBe("dest/a.txt");
  });

  it("uses basename when source ends in slash", () => {
    expect(moveDestinationPath("/root/out", "/tmp/dir/")).toBe("/root/out/dir");
  });
});
