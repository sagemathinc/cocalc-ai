import assert from "node:assert/strict";
import test from "node:test";

import { isProjectScopedRemoteForProject } from "./remote-scope";

test("isProjectScopedRemoteForProject requires matching remote project identity", () => {
  const projectId = "94ee01cf-2d7a-4e56-b8af-76d9a697877b";

  assert.equal(
    isProjectScopedRemoteForProject(
      { user: { project_id: projectId } },
      projectId,
    ),
    true,
  );

  assert.equal(
    isProjectScopedRemoteForProject({ user: { project_id: null } }, projectId),
    false,
  );

  assert.equal(
    isProjectScopedRemoteForProject(
      { user: { project_id: "00000000-1000-4000-8000-000000000000" } },
      projectId,
    ),
    false,
  );

  assert.equal(
    isProjectScopedRemoteForProject(
      { user: { project_id: projectId } },
      "not-a-project-id",
    ),
    false,
  );
});
