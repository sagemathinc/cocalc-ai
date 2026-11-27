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

describe("waiting for a free read slot", () => {
  it("runs extra reads as slots free up instead of failing them", async () => {
    const pool = new ReadAdmission("consumer");
    const held = Array.from({ length: 4 }, (_, i) =>
      pool.acquire("p", `account:a${i}`, "r"),
    );
    // like a course copying to 6 students at once
    const waiting = [
      pool.acquireWait("p", "account:x", "r", { timeoutMs: 5_000 }),
      pool.acquireWait("p", "account:y", "r", { timeoutMs: 5_000 }),
    ];
    let settled = 0;
    waiting.forEach((p) => p.then(() => settled++));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(0);
    held[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(1);
    held[1]();
    const releases = await Promise.all(waiting);
    // still capped at 4 while they run
    expect(() => pool.acquire("p", "account:z", "r")).toThrow("busy");
    releases.forEach((release) => release());
    held.slice(2).forEach((release) => release());
    pool.acquire("p", "account:z", "r")();
  });

  it("fails as busy after the timeout, leaving nothing reserved", async () => {
    const pool = new ReadAdmission("consumer");
    const held = Array.from({ length: 4 }, (_, i) =>
      pool.acquire("p", `account:a${i}`, "r"),
    );
    await expect(
      pool.acquireWait("p", "account:x", "r", { timeoutMs: 20 }),
    ).rejects.toThrow("file read consumer is busy");
    held.forEach((release) => release());
    const all = Array.from({ length: 4 }, (_, i) =>
      pool.acquire("p", `account:b${i}`, "r"),
    );
    all.forEach((release) => release());
  });

  it("stops waiting when aborted", async () => {
    const pool = new ReadAdmission("consumer");
    const held = Array.from({ length: 4 }, (_, i) =>
      pool.acquire("p", `account:a${i}`, "r"),
    );
    const abort = new AbortController();
    const pending = pool.acquireWait("p", "account:x", "r", {
      timeoutMs: 5_000,
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toThrow();
    held.forEach((release) => release());
  });

  it("acquires at once when there is room", async () => {
    const pool = new ReadAdmission("consumer");
    const release = await pool.acquireWait("p", "account:a", "r", {
      timeoutMs: 0,
    });
    release();
  });
});

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
