import { isTrashListingPath } from "./action-box";

describe("isTrashListingPath", () => {
  it("accepts both relative and absolute virtual trash paths", () => {
    expect(isTrashListingPath(".trash")).toBe(true);
    expect(isTrashListingPath(".trash/deleted.txt")).toBe(true);
    expect(isTrashListingPath("/.trash")).toBe(true);
    expect(isTrashListingPath("/.trash/deleted.txt")).toBe(true);
  });

  it("rejects normal filesystem paths", () => {
    expect(isTrashListingPath("/tmp")).toBe(false);
    expect(isTrashListingPath("/home/user/.trash-bin")).toBe(false);
    expect(isTrashListingPath(undefined)).toBe(false);
  });
});
