/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { _user_set_query_project_change_after } from "./methods-impl";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: jest.fn(async () => "event-id"),
}));

describe("project user-query outbox hooks", () => {
  const ctx = {
    _dbg: jest.fn(() => () => {}),
    publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function runHook(old_val: any, new_val: any): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      _user_set_query_project_change_after.call(
        ctx,
        old_val,
        new_val,
        "22222222-2222-4222-8222-222222222222",
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        },
      );
    });
  }

  it("emits project.summary_changed for title updates", async () => {
    await runHook(
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Old Title",
      },
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "New Title",
      },
    );
    expect(appendProjectOutboxEventForProject).toHaveBeenCalledWith({
      event_type: "project.summary_changed",
      project_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(ctx.publishProjectAccountFeedEventsBestEffort).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("emits project.deleted when a project is newly marked deleted", async () => {
    await runHook(
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        deleted: false,
      },
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        deleted: true,
      },
    );
    expect(appendProjectOutboxEventForProject).toHaveBeenCalledWith({
      event_type: "project.deleted",
      project_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(ctx.publishProjectAccountFeedEventsBestEffort).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not emit an outbox event when summary fields did not change", async () => {
    await runHook(
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Same Title",
      },
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        title: "Same Title",
      },
    );
    expect(appendProjectOutboxEventForProject).not.toHaveBeenCalled();
    expect(ctx.publishProjectAccountFeedEventsBestEffort).not.toHaveBeenCalled();
  });
});
