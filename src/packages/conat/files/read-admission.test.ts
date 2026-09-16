import { ReadAdmission } from "./read-admission";
import {
  FILE_READ_PRINCIPAL_HEADER,
  stampFileReadPrincipal,
} from "./read-principal";

describe.each(["producer", "consumer"] as const)(
  "%s admission fairness",
  (side) => {
    it("aggregates named services by project and releases all reservations", () => {
      const pool = new ReadAdmission(side);
      const releases = Array.from({ length: 4 }, (_, i) =>
        pool.acquire("p", `account:a${i}`, `reader-${i}`),
      );
      expect(() =>
        pool.acquire("p", "account:other", "different-name", 128),
      ).toThrow("busy");
      const other = pool.acquire("other-project", "account:other", "other");
      releases.forEach((release) => {
        release();
        release();
      });
      other();
      pool.acquire("p", "account:a", "retry")();
    });

    it("prevents one account filling the host with multiple projects", () => {
      const pool = new ReadAdmission(side);
      const releases = Array.from({ length: 8 }, (_, i) =>
        pool.acquire(`p${i}`, "account:a", `reader-${i}`),
      );
      expect(() =>
        pool.acquire("another-project", "account:a", "new-reader"),
      ).toThrow("busy");
      pool.acquire("another-project", "account:b", "new-reader")();
      releases.forEach((release) => release());
      pool.acquire("p", "account:a", "retry")();
    });

    it("still enforces the aggregate cap across unrelated principals", () => {
      const pool = new ReadAdmission(side);
      const releases = Array.from({ length: 64 }, (_, i) =>
        pool.acquire(`p${i}`, `account:a${i}`, "reader"),
      );
      expect(() =>
        pool.acquire("new-project", "account:new", "reader"),
      ).toThrow("busy");
      releases[0]();
      pool.acquire("new-project", "account:new", "reader")();
      releases.forEach((release) => release());
    });
  },
);

describe("router-owned file read identity", () => {
  const stamp = (user, trusted = false) => {
    const data = [
      "id",
      0,
      true,
      0,
      Buffer.alloc(0),
      { [FILE_READ_PRINCIPAL_HEADER]: "account:forged" },
    ];
    stampFileReadPrincipal({
      subject: "project.target.files:read.-",
      data,
      user,
      trusted,
    });
    return data[5]?.[FILE_READ_PRINCIPAL_HEADER];
  };
  it("overwrites account, project and anonymous spoofing", () => {
    expect(stamp({ account_id: "real" })).toBe("account:real");
    expect(stamp({ project_id: "real" })).toBe("project:real");
    expect(stamp(undefined)).toBe("unattributed");
  });
  it("preserves forwarded identity only for trusted service/cluster clients", () => {
    expect(stamp({ hub_id: "system" }, true)).toBe("account:forged");
  });

  it("preserves the unattributed bucket across trusted cluster hops", () => {
    const data = ["id", 0, true, 0, Buffer.alloc(0)];
    const args = {
      subject: "project.target.files:read.-",
      data,
      user: undefined,
      trusted: false,
    };
    stampFileReadPrincipal(args);
    stampFileReadPrincipal({
      ...args,
      user: { hub_id: "system" } as any,
      trusted: true,
    });
    expect(data[5]?.[FILE_READ_PRINCIPAL_HEADER]).toBe("unattributed");
  });
});
