import { resolveVirtualListingPath } from "./virtual-listing-path";

describe("resolveVirtualListingPath", () => {
  const homePath = "/projects/demo/home";

  it("maps snapshots virtual paths to the project home directory", () => {
    expect(
      resolveVirtualListingPath({
        path: ".snapshots",
        homePath,
      }),
    ).toBe("/projects/demo/home/.snapshots");
    expect(
      resolveVirtualListingPath({
        path: "/.snapshots/snap-1",
        homePath,
      }),
    ).toBe("/projects/demo/home/.snapshots/snap-1");
  });

  it("falls back to the runtime home while project capabilities are loading", () => {
    expect(
      resolveVirtualListingPath({
        path: "/.snapshots",
        homePath: "/",
      }),
    ).toBe("/home/user/.snapshots");
  });

  it("leaves non-snapshot paths unchanged", () => {
    expect(
      resolveVirtualListingPath({
        path: "/work",
        homePath,
      }),
    ).toBe("/work");
  });
});
