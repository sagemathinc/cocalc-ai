import assert from "node:assert/strict";
import test from "node:test";

import { isProjectScopedRemoteForProject } from "./remote-scope";

test("isProjectScopedRemoteForProject requires matching remote project identity", () => {
  delete process.env.COCALC_DEV_ENV_MODE;
  delete process.env.COCALC_LITE_CONNECTION_INFO;
  delete process.env.COCALC_PROJECT_ID;
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

test("isProjectScopedRemoteForProject treats Lite dev env as project-scoped for the current project", () => {
  const projectId = "00000000-1000-4000-8000-000000000000";
  const originalMode = process.env.COCALC_DEV_ENV_MODE;
  const originalConnection = process.env.COCALC_LITE_CONNECTION_INFO;
  const originalProjectId = process.env.COCALC_PROJECT_ID;
  try {
    process.env.COCALC_DEV_ENV_MODE = "lite";
    process.env.COCALC_LITE_CONNECTION_INFO = "/tmp/lite-connection.json";
    process.env.COCALC_PROJECT_ID = projectId;
    assert.equal(
      isProjectScopedRemoteForProject(
        { user: { project_id: null } },
        projectId,
      ),
      true,
    );
    assert.equal(
      isProjectScopedRemoteForProject(
        { user: { project_id: null } },
        "11111111-1111-4111-8111-111111111111",
      ),
      false,
    );
  } finally {
    if (originalMode == null) {
      delete process.env.COCALC_DEV_ENV_MODE;
    } else {
      process.env.COCALC_DEV_ENV_MODE = originalMode;
    }
    if (originalConnection == null) {
      delete process.env.COCALC_LITE_CONNECTION_INFO;
    } else {
      process.env.COCALC_LITE_CONNECTION_INFO = originalConnection;
    }
    if (originalProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = originalProjectId;
    }
  }
});
