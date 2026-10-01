import { randomUUID } from "node:crypto";
import {
  readPeopleInvitationDelivery,
  refreshPeopleInvitationDelivery,
} from "./invitations-delivery";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import { readContentInvitationDeliveryOnHomeBay } from "@cocalc/server/notifications/content-invitation-delivery";
import type { PeopleInvitationOperation } from "@cocalc/util/people-invitations";

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "sender-home",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: jest.fn(),
}));
jest.mock("@cocalc/server/notifications/content-invitation-delivery", () => ({
  readContentInvitationDeliveryOnHomeBay: jest.fn(),
}));

describe("invitation delivery routing", () => {
  const sender_account_id = randomUUID(),
    recipient_account_id = randomUUID(),
    notification_id = randomUUID();
  beforeEach(() => jest.clearAllMocks());
  const request = () => ({
    sender_account_id,
    recipient_account_id,
    notification_ids: [notification_id],
  });
  function operation(): PeopleInvitationOperation {
    return {
      operation_id: randomUUID(),
      account_id: sender_account_id,
      draft_id: randomUUID(),
      revision: 1,
      status: "complete",
      created_at: Date.now(),
      updated_at: Date.now(),
      source_version: 1,
      authorization_expires_at: Date.now() + 1000,
      payload: {
        recipient: { kind: "account", account_id: recipient_account_id },
        projects: [],
        message: "",
        channels: { notification: false, email: true },
      },
      outcomes: [
        {
          project_id: randomUUID(),
          action: "notify",
          child_operation_id: randomUUID(),
          status: "notified",
          delivery: [
            { channel: "notification", status: "suppressed" },
            { channel: "email", status: "queued", receipt_id: notification_id },
          ],
        },
      ],
    };
  }
  it("uses current recipient home, never the sender-local recipient copy", async () => {
    jest
      .mocked(resolveAccountHomeBay)
      .mockResolvedValue({ home_bay_id: "recipient-home" } as any);
    const readInvitationDelivery = jest.fn(async () => []);
    jest
      .mocked(createInterBayCollaboratorsClient)
      .mockReturnValue({ readInvitationDelivery } as any);
    await readPeopleInvitationDelivery(request());
    expect(resolveAccountHomeBay).toHaveBeenCalledWith({
      account_id: recipient_account_id,
    });
    expect(readInvitationDelivery).toHaveBeenCalledWith({
      ...request(),
      route: { bay_id: "recipient-home" },
    });
    expect(readContentInvitationDeliveryOnHomeBay).not.toHaveBeenCalled();
  });
  it("overlays current sent/failed evidence while leaving unrequested channels suppressed and ID-free", async () => {
    jest
      .mocked(resolveAccountHomeBay)
      .mockResolvedValue({ home_bay_id: "sender-home" } as any);
    jest.mocked(readContentInvitationDeliveryOnHomeBay).mockResolvedValue([
      {
        notification_id,
        delivery: [
          {
            channel: "notification",
            status: "sent",
            receipt_id: notification_id,
          },
          {
            channel: "email",
            status: "failed",
            receipt_id: notification_id,
            reason: "email_delivery_failed",
          },
        ],
      },
    ]);
    const op = operation();
    await refreshPeopleInvitationDelivery(op);
    expect(op.outcomes[0].delivery).toEqual([
      {
        channel: "notification",
        status: "suppressed",
        reason: "not_requested",
      },
      {
        channel: "email",
        status: "failed",
        receipt_id: notification_id,
        reason: "email_delivery_failed",
      },
    ]);
  });
  it("reports unavailable receipt evidence as unknown instead of leaving queued forever", async () => {
    jest
      .mocked(resolveAccountHomeBay)
      .mockRejectedValue(Error("recipient home unavailable"));
    const op = operation();
    await refreshPeopleInvitationDelivery(op);
    expect(op.outcomes[0].delivery[1]).toMatchObject({
      status: "unknown",
      reason: "delivery_status_unavailable",
    });
    expect(readContentInvitationDeliveryOnHomeBay).not.toHaveBeenCalled();
  });
  it("deduplicates shared multi-project receipt identities into one bounded lookup", async () => {
    jest
      .mocked(resolveAccountHomeBay)
      .mockResolvedValue({ home_bay_id: "sender-home" } as any);
    jest.mocked(readContentInvitationDeliveryOnHomeBay).mockResolvedValue([]);
    const op = operation();
    op.outcomes.push(structuredClone(op.outcomes[0]));
    await refreshPeopleInvitationDelivery(op);
    expect(readContentInvitationDeliveryOnHomeBay).toHaveBeenCalledWith(
      request(),
    );
  });
});
