import { acceptAgentMessage } from "./messaging";
import {
  grantMessaging,
  authorizeDelivery,
  beginMessageAdmission,
} from "./api";
import { agentStore } from "./store";

jest.mock("./store", () => ({
  agentStore: jest.fn(() => {
    throw new Error("legacy storage must not be touched");
  }),
  agentMessagingEnabled: () => true,
}));

test("an old sender cannot enqueue work or silently switch protocols", async () => {
  await expect(
    acceptAgentMessage("unused", { action: "send" } as any),
  ).rejects.toThrow("Legacy delivery is retired");
  expect(agentStore).not.toHaveBeenCalled();
});

test.each([grantMessaging, authorizeDelivery, beginMessageAdmission])(
  "old grant and execution endpoints fail closed without touching records",
  async (api) => {
    await expect(api({} as any)).rejects.toThrow(/Legacy/);
    expect(agentStore).not.toHaveBeenCalled();
  },
);
