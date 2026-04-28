import immutable from "immutable";

import { canUseCollaboratorProjectRealtime } from "./realtime-access";

describe("canUseCollaboratorProjectRealtime", () => {
  it("allows admins without collaborator entries", () => {
    expect(
      canUseCollaboratorProjectRealtime({
        account_id: "acct-1",
        is_admin: true,
        project_id: "project-1",
        projectsStore: undefined,
      }),
    ).toBe(true);
  });

  it("allows collaborators listed in project_map", () => {
    const projectsStore = immutable.Map({
      project_map: immutable.Map({
        "project-1": immutable.Map({
          users: immutable.Map({
            "acct-1": immutable.Map({ group: "collaborator" }),
          }),
        }),
      }),
    });
    expect(
      canUseCollaboratorProjectRealtime({
        account_id: "acct-1",
        project_id: "project-1",
        projectsStore,
      }),
    ).toBe(true);
  });

  it("blocks missing or non-collaborator projects", () => {
    const projectsStore = immutable.Map({
      project_map: immutable.Map({
        "project-1": immutable.Map({
          users: immutable.Map({
            "acct-2": immutable.Map({ group: "owner" }),
          }),
        }),
      }),
    });
    expect(
      canUseCollaboratorProjectRealtime({
        account_id: "acct-1",
        project_id: "project-1",
        projectsStore,
      }),
    ).toBe(false);
    expect(
      canUseCollaboratorProjectRealtime({
        account_id: "acct-1",
        project_id: "project-missing",
        projectsStore,
      }),
    ).toBe(false);
  });
});
