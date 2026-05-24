import { runLeaveOrDeleteProjectsSequentially } from "./projects-bulk-delete";

describe("runLeaveOrDeleteProjectsSequentially", () => {
  it("waits for each queued hard delete before submitting the next project", async () => {
    const events: string[] = [];

    const result = await runLeaveOrDeleteProjectsSequentially({
      project_ids: ["p1", "p2", "p3"],
      submitProject: async (project_id) => {
        events.push(`submit:${project_id}`);
        return [
          {
            project_id,
            action: "hard_delete_queued",
            op_id: `op-${project_id}`,
          },
        ];
      },
      waitForQueuedDelete: async ({ project_id, op_id }) => {
        events.push(`wait:${project_id}:${op_id}`);
      },
    });

    expect(result.stopped).toBe(false);
    expect(result.results.map((entry) => entry.project_id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(events).toEqual([
      "submit:p1",
      "wait:p1:op-p1",
      "submit:p2",
      "wait:p2:op-p2",
      "submit:p3",
      "wait:p3:op-p3",
    ]);
  });

  it("stops instead of queuing more deletes when queued-delete status is unknown", async () => {
    const submitted: string[] = [];

    const result = await runLeaveOrDeleteProjectsSequentially({
      project_ids: ["p1", "p2"],
      submitProject: async (project_id) => {
        submitted.push(project_id);
        return [
          {
            project_id,
            action: "hard_delete_queued",
            op_id: `op-${project_id}`,
          },
        ];
      },
      waitForQueuedDelete: async () => {
        throw new Error("network unavailable");
      },
    });

    expect(result.stopped).toBe(true);
    expect(submitted).toEqual(["p1"]);
    expect(result.results).toEqual([
      {
        project_id: "p1",
        action: "error",
        op_id: "op-p1",
        error: "Error: network unavailable",
      },
    ]);
  });

  it("propagates fresh auth errors so the caller can open the fresh-auth modal", async () => {
    const submitted: string[] = [];
    const freshAuthError = new Error("fresh auth required");
    (freshAuthError as any).code = "fresh_auth_required";

    await expect(
      runLeaveOrDeleteProjectsSequentially({
        project_ids: ["p1", "p2", "p3"],
        submitProject: async (project_id) => {
          submitted.push(project_id);
          if (project_id === "p1") {
            throw freshAuthError;
          }
          return [{ project_id, action: "removed_self" }];
        },
        waitForQueuedDelete: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "fresh_auth_required" });

    expect(submitted).toEqual(["p1"]);
  });
});
