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
const base = {
  mountedPlain: false,
  mountedIdmap: false,
  sameImage: true,
  holders: 0,
};

describe("rootfsMountAction", () => {
  it("mounts afresh when nothing is mounted", () => {
    expect(rootfsMountAction(base)).toBe("replace");
    expect(rootfsMountAction({ ...base, idmapUid: P })).toBe("replace");
  });

  it("reuses a mount of the requested way and image", () => {
    expect(rootfsMountAction({ ...base, mountedPlain: true, holders: 1 })).toBe(
      "reuse",
    );
    expect(
      rootfsMountAction({
        ...base,
        mountedIdmap: true,
        idmapUid: P,
        currentIdmapUid: P,
        holders: 1,
      }),
    ).toBe("reuse");
  });

  it("replaces a mount of the requested way with another image", () => {
    expect(
      rootfsMountAction({
        ...base,
        mountedPlain: true,
        sameImage: false,
        holders: 1,
      }),
    ).toBe("replace");
  });

  it("never pulls an idmapped rootfs from under a running project for a plain request", () => {
    // e.g. a sidecar on a project that runs with a separate runtime uid
    expect(
      rootfsMountAction({
        ...base,
        mountedIdmap: true,
        currentIdmapUid: P,
        holders: 1,
      }),
    ).toBe("refuse");
    // the same with a stale uid record (after a daemon restart)
    expect(rootfsMountAction({ ...base, mountedIdmap: true, holders: 2 })).toBe(
      "refuse",
    );
  });

  it("never pulls a plain rootfs from under its users for an idmapped request", () => {
    expect(
      rootfsMountAction({
        ...base,
        mountedPlain: true,
        idmapUid: P,
        holders: 1,
      }),
    ).toBe("refuse");
  });

  it("switches the way once nothing holds the mount", () => {
    expect(
      rootfsMountAction({ ...base, mountedIdmap: true, currentIdmapUid: P }),
    ).toBe("replace");
    expect(
      rootfsMountAction({ ...base, mountedPlain: true, idmapUid: P }),
    ).toBe("replace");
    // both mounted (a crash between the two): not the requested way
    expect(
      rootfsMountAction({
        ...base,
        mountedPlain: true,
        mountedIdmap: true,
        idmapUid: P,
        currentIdmapUid: P,
      }),
    ).toBe("replace");
  });
});
