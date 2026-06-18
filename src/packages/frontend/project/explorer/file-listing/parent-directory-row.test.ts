import {
  hasRealListingRows,
  isParentDirectoryRow,
  parentDirectoryPath,
  withParentDirectoryRow,
} from "./parent-directory-row";

describe("parent directory row", () => {
  const listing = [
    { name: "src", isDir: true },
    { name: "README.md", isDir: false },
  ];

  it("prepends a parent directory row for non-root directories", () => {
    expect(
      withParentDirectoryRow({
        currentPath: "/home/user/project",
        fileSearch: "",
        listing,
      }).map((entry) => entry.name),
    ).toEqual(["..", "src", "README.md"]);
  });

  it("marks a synthetic parent row without treating it as real listing content", () => {
    const rows = withParentDirectoryRow({
      currentPath: "/home/user/project",
      fileSearch: "",
      listing: [],
    });

    expect(rows).toHaveLength(1);
    expect(isParentDirectoryRow(rows[0])).toBe(true);
    expect(hasRealListingRows(rows)).toBe(false);
    expect(hasRealListingRows([...rows, { name: "README.md" }])).toBe(true);
  });

  it("does not add a parent row at filesystem root", () => {
    expect(
      withParentDirectoryRow({
        currentPath: "/",
        fileSearch: "",
        listing,
      }),
    ).toBe(listing);
  });

  it("hides the parent row while filtering files", () => {
    expect(
      withParentDirectoryRow({
        currentPath: "/home/user/project",
        fileSearch: "readme",
        listing,
      }),
    ).toBe(listing);
  });

  it("does not duplicate an existing parent row", () => {
    const withParent = [{ name: "..", isDir: true }, ...listing];
    expect(
      withParentDirectoryRow({
        currentPath: "/home/user/project",
        fileSearch: "",
        listing: withParent,
      }),
    ).toBe(withParent);
  });

  it("normalizes parent paths for navigation", () => {
    expect(parentDirectoryPath("/home/user/project")).toBe("/home/user");
    expect(parentDirectoryPath("/home/user/project/")).toBe("/home/user");
    expect(parentDirectoryPath("/")).toBe("/");
  });
});
