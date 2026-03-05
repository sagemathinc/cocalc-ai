/** @jest-environment jsdom */

import { deleteAllActivityLogs } from "../actions/activity-logs";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    conat_client: {
      conat: jest.fn(),
    },
  },
}));

describe("deleteAllActivityLogs", () => {
  it("prefers explicit log refs on messages over derived refs", async () => {
    const deleteFn = jest.fn().mockResolvedValue(undefined);
    (webapp_client.conat_client.conat as any).mockReturnValue({
      sync: {
        akv: ({ name }: { name: string }) => ({
          delete: (key: string) => deleteFn(name, key),
        }),
      },
    });
    const rootDate = new Date("2026-03-05T20:00:00.000Z");
    const turnDate = new Date("2026-03-05T20:01:00.000Z");
    const msg = {
      sender_id: "assistant",
      date: turnDate,
      thread_id: "thread-1",
      acp_log_store: "explicit-store",
      acp_log_key: "explicit-key",
    };
    const actions: any = {
      syncdb: {
        set: jest.fn(),
        commit: jest.fn(),
      },
      getMessagesInThread: jest.fn().mockReturnValue([msg]),
    };

    await deleteAllActivityLogs({
      actions,
      threadRootMs: rootDate.valueOf(),
      threadId: "thread-1",
      message: msg as any,
      project_id: "proj-1",
      path: "x.chat",
    });

    expect(deleteFn).toHaveBeenCalledWith("explicit-store", "explicit-key");
    expect(actions.syncdb.set).toHaveBeenCalledWith({
      event: "chat",
      date: turnDate.toISOString(),
      sender_id: "assistant",
      acp_events: null,
      codex_events: null,
    });
    expect(actions.syncdb.commit).toHaveBeenCalled();
  });
});
