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
          account_id: "11111111-1111-4111-8111-111111111111",
          project_id: "22222222-2222-4222-8222-222222222222",
          hub_id: "33333333-3333-4333-8333-333333333333",
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

  it("uses the signed-in account identity as the sync client identity", () => {
    const client = createConatClient({ id: "conn-live-1" });
    const syncClient = new SyncClient(client as any);

    expect(syncClient.client_id()).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("records account activity without issuing a project-scoped touch", async () => {
    const client = createConatClient({
      id: "conn-live-2",
      info: {
        user: {
          account_id: "44444444-4444-4444-8444-444444444444",
          project_id: "55555555-5555-4555-8555-555555555555",
          hub_id: "66666666-6666-4666-8666-666666666666",
        },
      },
    });
    const syncClient = new SyncClient(client as any);

    await syncClient.touch_project("project-under-edit");

    expect(callHubMock).toHaveBeenCalledTimes(1);
    expect(callHubMock).toHaveBeenCalledWith({
      client,
      account_id: "44444444-4444-4444-8444-444444444444",
      name: "db.touch",
      args: [
        {
          account_id: "44444444-4444-4444-8444-444444444444",
        },
      ],
    });
  });
});
