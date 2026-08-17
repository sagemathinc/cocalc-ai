/*
 * This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import {
  closeAcpDatabase,
  getAcpDatabase,
  initAcpDatabase,
} from "../../sqlite/acp-database";
import {
  getAcpRuntimeOwner,
  releaseAcpRuntimeOwner,
  releaseAcpRuntimeOwnersForWorker,
  upsertAcpRuntimeOwner,
} from "../../sqlite/acp-runtime-owners";

beforeAll(() => {
  closeAcpDatabase();
  initAcpDatabase({ filename: ":memory:" });
  getAcpRuntimeOwner("initialize-table");
});

beforeEach(() => {
  getAcpDatabase().prepare("DELETE FROM acp_runtime_owners").run();
});

afterAll(() => {
  closeAcpDatabase();
});

describe("ACP retained runtime ownership", () => {
  it("moves a session atomically to its current worker", () => {
    const first = upsertAcpRuntimeOwner({
      session_id: "session-1",
      worker_id: "worker-old",
      project_id: "project-1",
      account_id: "account-1",
      path: "a.chat",
    });
    const second = upsertAcpRuntimeOwner({
      session_id: "session-1",
      worker_id: "worker-new",
      project_id: "project-1",
      account_id: "account-1",
      path: "a.chat",
    });

    expect(first.worker_id).toBe("worker-old");
    expect(second.worker_id).toBe("worker-new");
    expect(second.created_at).toBe(first.created_at);
    expect(
      releaseAcpRuntimeOwner({
        session_id: "session-1",
        worker_id: "worker-old",
      }),
    ).toBe(false);
    expect(getAcpRuntimeOwner("session-1")?.worker_id).toBe("worker-new");
  });

  it("releases every session owned by a stopped worker", () => {
    for (const session_id of ["session-a", "session-b"]) {
      upsertAcpRuntimeOwner({
        session_id,
        worker_id: "worker-old",
        project_id: "project-1",
      });
    }
    upsertAcpRuntimeOwner({
      session_id: "session-c",
      worker_id: "worker-live",
      project_id: "project-1",
    });

    expect(releaseAcpRuntimeOwnersForWorker("worker-old")).toBe(2);
    expect(getAcpRuntimeOwner("session-a")).toBeUndefined();
    expect(getAcpRuntimeOwner("session-b")).toBeUndefined();
    expect(getAcpRuntimeOwner("session-c")?.worker_id).toBe("worker-live");
  });
});
