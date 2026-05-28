/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  isProjectCollaboratorRole,
  projectAccessFromUsers,
  viewerReadPolicyAllowsPath,
  viewerReadPolicyMayAllowDescendant,
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

describe("viewer read policy path matching", () => {
  it("requires an explicit include rule", () => {
    expect(
      viewerReadPolicyAllowsPath({
        policy: undefined,
        path: "README.md",
      }),
    ).toBe(false);
    expect(
      viewerReadPolicyAllowsPath({
        policy: { rules: [] },
        path: "README.md",
      }),
    ).toBe(false);
  });

  it("treats dot include as full project access", () => {
    const policy = {
      rules: [{ action: "include" as const, path: "." }],
    };
    expect(viewerReadPolicyAllowsPath({ policy, path: "" })).toBe(true);
    expect(viewerReadPolicyAllowsPath({ policy, path: "README.md" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: "docs/index.md" })).toBe(
      true,
    );
  });

  it("lets deny rules win over includes", () => {
    const policy = {
      rules: [
        { action: "include" as const, path: "." },
        { action: "exclude" as const, path: ".snapshots" },
        { action: "exclude" as const, path: ".snapshots/**" },
      ],
    };
    expect(viewerReadPolicyAllowsPath({ policy, path: "docs/index.md" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: ".snapshots" })).toBe(
      false,
    );
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: ".snapshots/2026-05-27/secret.txt",
      }),
    ).toBe(false);
  });

  it("supports simple selected directory and file rules", () => {
    const policy = {
      rules: [
        { action: "include" as const, path: "public/**" },
        { action: "include" as const, path: "README.md" },
      ],
    };
    expect(viewerReadPolicyAllowsPath({ policy, path: "public" })).toBe(true);
    expect(viewerReadPolicyAllowsPath({ policy, path: "public/a.txt" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: "README.md" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: "private/a.txt" })).toBe(
      false,
    );
  });

  it("rejects paths that normalize above the project root", () => {
    const policy = {
      rules: [{ action: "include" as const, path: "." }],
    };
    expect(viewerReadPolicyAllowsPath({ policy, path: "../secret" })).toBe(
      false,
    );
  });

  it("detects visible ancestors for selected viewer paths", () => {
    const policy = {
      rules: [{ action: "include" as const, path: "foo/bar/**" }],
    };
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "" })).toBe(true);
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "foo" })).toBe(
      true,
    );
    expect(
      viewerReadPolicyMayAllowDescendant({ policy, path: "foo/bar" }),
    ).toBe(true);
    expect(
      viewerReadPolicyMayAllowDescendant({ policy, path: "private" }),
    ).toBe(false);
  });

  it("does not expose descendants below excluded viewer paths", () => {
    const policy = {
      rules: [
        { action: "include" as const, path: "." },
        { action: "exclude" as const, path: ".ssh" },
        { action: "exclude" as const, path: ".ssh/**" },
      ],
    };
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "" })).toBe(true);
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: ".ssh" })).toBe(
      false,
    );
  });

  it("supports glob include ancestors for viewer navigation", () => {
    const policy = {
      rules: [{ action: "include" as const, path: "docs/*.md" }],
    };
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "" })).toBe(true);
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "docs" })).toBe(
      true,
    );
    expect(viewerReadPolicyMayAllowDescendant({ policy, path: "src" })).toBe(
      false,
    );
  });
});
