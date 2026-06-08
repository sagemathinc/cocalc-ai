import { isAlreadyInFolder, isSelfFolderDrop } from "./file-dnd-provider";

describe("file explorer drag/drop path classification", () => {
  it("does not treat a parent breadcrumb drop as already in the target folder", () => {
    expect(isAlreadyInFolder(["/home/user/foo/bar.txt"], "/home/user")).toBe(
      false,
    );
  });

  it("treats dropping onto the current containing folder as already in target", () => {
    expect(
      isAlreadyInFolder(["/home/user/foo/bar.txt"], "/home/user/foo"),
    ).toBe(true);
  });

  it("detects moving a folder into itself or a child as self-drop", () => {
    expect(isSelfFolderDrop(["/home/user/foo"], "/home/user/foo")).toBe(true);
    expect(isSelfFolderDrop(["/home/user/foo"], "/home/user/foo/sub")).toBe(
      true,
    );
    expect(isSelfFolderDrop(["/home/user/foo"], "/home/user")).toBe(false);
  });
});
