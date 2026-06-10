import { Map } from "immutable";

import { shouldSendProjectStop } from "./projects-operations";

function project({
  host_id = "host-1",
  state = "running",
}: {
  host_id?: string | null;
  state?: string;
} = {}) {
  return Map({
    host_id,
    state: Map({ state }),
  });
}

describe("shouldSendProjectStop", () => {
  it("sends stop for active projects on running hosts", () => {
    expect(shouldSendProjectStop(project(), Map({ status: "running" }))).toBe(
      true,
    );
    expect(shouldSendProjectStop(project(), Map({ status: "active" }))).toBe(
      true,
    );
  });

  it("skips projects that are already stopped or unassigned", () => {
    expect(
      shouldSendProjectStop(
        project({ state: "opened" }),
        Map({ status: "running" }),
      ),
    ).toBe(false);
    expect(
      shouldSendProjectStop(
        project({ host_id: null, state: "running" }),
        undefined,
      ),
    ).toBe(false);
  });

  it("skips active-looking projects on known non-running hosts", () => {
    expect(
      shouldSendProjectStop(project(), Map({ status: "deprovisioned" })),
    ).toBe(false);
    expect(shouldSendProjectStop(project(), Map({ status: "off" }))).toBe(
      false,
    );
    expect(
      shouldSendProjectStop(
        project(),
        Map({ status: "running", deleted: new Date() }),
      ),
    ).toBe(false);
  });

  it("does not block stop when host status is not loaded yet", () => {
    expect(shouldSendProjectStop(project(), undefined)).toBe(true);
    expect(shouldSendProjectStop(project(), Map())).toBe(true);
  });
});
