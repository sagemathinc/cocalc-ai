import {
  countVisibleDirectoryEntries,
  getCachedDirectoryItemCount,
} from "./directory-item-count";

const getFiles = jest.fn();
const getCachedBackupsListing = jest.fn();

jest.mock("@cocalc/frontend/project/listing/use-files", () => ({
  getFiles: (...args: any[]) => getFiles(...args),
  getCacheId: ({ project_id }) => ({ project_id }),
}));

jest.mock("@cocalc/frontend/project/listing/use-backups", () => ({
  getCachedBackupsListing: (...args: any[]) => getCachedBackupsListing(...args),
}));

describe("directory item count helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("counts visible cached entries for regular directories", () => {
    getFiles.mockReturnValue({
      "alpha.txt": { size: 1 },
      ".hidden": { size: 1 },
      __pycache__: { size: 1, isDir: true },
      "..": { size: 1, isDir: true },
    });

    expect(
      getCachedDirectoryItemCount({
        project_id: "project-1",
        current_path: "/home/user",
        dirName: "src",
        showHidden: false,
        hideMaskedFiles: true,
      }),
    ).toBe(1);
  });

  it("returns null when a child listing is not cached", () => {
    getFiles.mockReturnValue(null);

    expect(
      getCachedDirectoryItemCount({
        project_id: "project-1",
        current_path: "/home/user",
        dirName: "src",
        showHidden: true,
        hideMaskedFiles: false,
      }),
    ).toBeNull();
  });

  it("uses the backups cache for .backups listings", () => {
    getCachedBackupsListing.mockReturnValue([
      { name: "one.txt", size: 1, mtime: 1 },
      { name: "two.txt", size: 1, mtime: 1 },
    ]);

    expect(
      getCachedDirectoryItemCount({
        project_id: "project-1",
        current_path: "/.backups",
        dirName: "2026-04-06T00:00:00.000Z",
        showHidden: true,
        hideMaskedFiles: false,
      }),
    ).toBe(2);
    expect(getCachedBackupsListing).toHaveBeenCalledWith({
      project_id: "project-1",
      path: "/.backups/2026-04-06T00:00:00.000Z",
    });
  });

  it("filters hidden entries from cached counts when show hidden is off", () => {
    expect(
      countVisibleDirectoryEntries({
        entries: [
          { name: "one.txt", size: 1, mtime: 1 },
          { name: ".two.txt", size: 1, mtime: 1 },
          { name: "..", size: 1, mtime: 1, isDir: true },
        ],
        showHidden: false,
        hideMaskedFiles: false,
      }),
    ).toBe(1);
  });
});
