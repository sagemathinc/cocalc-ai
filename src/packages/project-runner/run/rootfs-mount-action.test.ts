jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return { __esModule: true, default: factory, getLogger: factory };
});
jest.mock("./conat-client", () => ({ getConatClient: jest.fn() }));

import { rootfsMountAction } from "./rootfs";

const P = 1073741824;
const Q = 1073741825;
const base = {
  mountedPlain: false,
  mountedIdmap: false,
  sameImage: true,
  holders: 0,
  authorized: false,
};
const plain = { ...base, mountedPlain: true };
const idmapped = { ...base, mountedIdmap: true, currentIdmapUid: P };

describe("rootfsMountAction", () => {
  it("mounts afresh when nothing is mounted", () => {
    expect(rootfsMountAction(base)).toEqual({ action: "replace" });
    expect(rootfsMountAction({ ...base, idmapUid: P })).toEqual({
      action: "replace",
    });
  });

  it("reuses only the same way, uid and image", () => {
    expect(rootfsMountAction({ ...plain, holders: 1 })).toEqual({
      action: "reuse",
    });
    expect(rootfsMountAction({ ...idmapped, idmapUid: P, holders: 1 })).toEqual(
      { action: "reuse" },
    );
  });

  it("never replaces a held mount, whatever differs", () => {
    const cases: [object, string][] = [
      [{ ...plain, sameImage: false }, "image"],
      [{ ...idmapped, idmapUid: P, sameImage: false }, "image"],
      [{ ...idmapped }, "way"],
      [{ ...plain, idmapUid: P }, "way"],
      [{ ...idmapped, idmapUid: Q }, "uid"],
      [{ ...plain, mountedIdmap: true, idmapUid: P }, "both"],
    ];
    for (const [state, mismatch] of cases) {
      // held here, even with an authorized caller
      expect(
        rootfsMountAction({ ...base, ...state, holders: 1, authorized: true }),
      ).toEqual({ action: "refuse", mismatch });
      // held by nobody here, but nothing proves it unused (e.g. after a
      // daemon restart, with the project's containers still running)
      expect(rootfsMountAction({ ...base, ...state, holders: 0 })).toEqual({
        action: "refuse",
        mismatch,
      });
      // held by nobody, and proven unused
      expect(
        rootfsMountAction({ ...base, ...state, holders: 0, authorized: true }),
      ).toEqual({ action: "replace" });
    }
  });

  it("treats a mount for another uid as different (the step-2 pool)", () => {
    expect(rootfsMountAction({ ...idmapped, idmapUid: Q, holders: 1 })).toEqual(
      { action: "refuse", mismatch: "uid" },
    );
    expect(
      rootfsMountAction({ ...idmapped, idmapUid: Q, authorized: true }),
    ).toEqual({ action: "replace" });
  });
});
