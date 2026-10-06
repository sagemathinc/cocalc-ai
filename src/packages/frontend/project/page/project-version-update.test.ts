import {
  projectUpdateStatus,
  UPDATE_QUIET_MS,
  updateQuietUntil,
} from "./project-version-update";

// Bundle and tools versions are build times in ms.
const old = "1791000000000";
const now = "1791099701123";

describe("project update status", () => {
  it("is quiet when the project runs what its host has", () => {
    expect(
      projectUpdateStatus({
        runningBundle: now,
        runningTools: now,
        hostBundle: now,
        hostTools: now,
      }),
    ).toBeUndefined();
  });

  it("recommends a restart for newer project code or tools", () => {
    expect(
      projectUpdateStatus({ runningBundle: old, hostBundle: now }),
    ).toEqual({
      level: "recommended",
      parts: ["project code"],
      since: Number(now),
    });
    expect(
      projectUpdateStatus({
        runningBundle: now,
        hostBundle: now,
        runningTools: old,
        hostTools: now,
      })?.parts,
    ).toEqual(["tools"]);
  });

  it("ignores a host rolled back to older software and unknown versions", () => {
    expect(
      projectUpdateStatus({ runningBundle: now, hostBundle: old }),
    ).toBeUndefined();
    expect(projectUpdateStatus({ runningBundle: old })).toBeUndefined();
  });

  it("requires a restart below the site minimum only when it would help", () => {
    const minProject = Math.floor(Number(now) / 1000);
    expect(
      projectUpdateStatus({ runningBundle: old, hostBundle: now, minProject })
        ?.level,
    ).toBe("required");
    // Already on the newest code: restarting would not change anything.
    expect(
      projectUpdateStatus({
        runningBundle: now,
        hostBundle: now,
        minProject: minProject + 60,
      }),
    ).toBeUndefined();
  });
});

describe("update quiet period after a restart", () => {
  const t = 1_791_266_000_000;

  it("starts when this browser requests the restart", () => {
    expect(updateQuietUntil({ requestedAt: t })).toBe(t + UPDATE_QUIET_MS);
  });

  it("starts when the project's current run started, for other tabs too", () => {
    expect(updateQuietUntil({ startedAt: new Date(t).toISOString() })).toBe(
      t + UPDATE_QUIET_MS,
    );
    expect(updateQuietUntil({ startedAt: new Date(t) })).toBe(
      t + UPDATE_QUIET_MS,
    );
  });

  it("uses the later of the two, and is over without either", () => {
    expect(
      updateQuietUntil({ requestedAt: t, startedAt: new Date(t + 5_000) }),
    ).toBe(t + 5_000 + UPDATE_QUIET_MS);
    expect(updateQuietUntil({})).toBe(-Infinity);
    expect(updateQuietUntil({ startedAt: "not a date" })).toBe(-Infinity);
  });
});
