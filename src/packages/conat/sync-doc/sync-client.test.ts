jest.mock("@cocalc/conat/hub/call-hub", () => jest.fn());

import callHub from "@cocalc/conat/hub/call-hub";
import { SyncClient } from "./sync-client";

describe("SyncClient", () => {
  const callHubMock = callHub as jest.MockedFunction<typeof callHub>;

  beforeEach(() => {
    callHubMock.mockReset();
  });

  function createConatClient(overrides: Partial<any> = {}) {
    return {
      id: "conn-123",
      info: {
        user: {
          account_id: "acct-456",
          project_id: "proj-789",
          hub_id: "hub-000",
        },
      },
      isConnected: () => true,
      isSignedIn: () => true,
      once: jest.fn(),
      sync: {
        synctable: jest.fn(),
      },
      ...overrides,
    };
  }

  it("uses the live connection id as the sync client identity", () => {
    const client = createConatClient({ id: "conn-live-1" });
    const syncClient = new SyncClient(client as any);

    expect(syncClient.client_id()).toBe("conn-live-1");
  });

  it("still touches projects using the user account identity", async () => {
    const client = createConatClient({
      id: "conn-live-2",
      info: {
        user: {
          account_id: "acct-real",
          project_id: "proj-real",
          hub_id: "hub-real",
        },
      },
    });
    const syncClient = new SyncClient(client as any);

    await syncClient.touch_project("project-under-edit");

    expect(callHubMock).toHaveBeenCalledTimes(1);
    expect(callHubMock).toHaveBeenCalledWith({
      client,
      account_id: "acct-real",
      name: "db.touch",
      args: [{ project_id: "project-under-edit", account_id: "acct-real" }],
    });
  });
});
