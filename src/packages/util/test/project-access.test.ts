/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isProjectCollaboratorRole,
  projectAccessFromUsers,
} from "@cocalc/util/project-access";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("project access capabilities", () => {
  it("does not treat viewers as collaborators", () => {
    expect(isProjectCollaboratorRole("owner")).toBe(true);
    expect(isProjectCollaboratorRole("collaborator")).toBe(true);
    expect(isProjectCollaboratorRole("viewer")).toBe(false);
  });

  it("derives viewer file-read capabilities without write or runtime access", () => {
    const read_policy = {
      rules: [{ action: "include" as const, path: "public/**" }],
    };
    const access = projectAccessFromUsers({
      account_id: ACCOUNT_ID,
      users: {
        [ACCOUNT_ID]: {
          group: "viewer",
          read_policy,
        },
      },
    });
    expect(access.role).toBe("viewer");
    expect(access.read_policy).toBe(read_policy);
    expect(access.capabilities.readProjectFiles).toBe(true);
    expect(access.capabilities.writeProjectFiles).toBe(false);
    expect(access.capabilities.useProjectRuntime).toBe(false);
    expect(access.capabilities.manageCollaborators).toBe(false);
  });
});
