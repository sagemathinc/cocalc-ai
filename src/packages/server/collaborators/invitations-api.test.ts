import { randomUUID } from "node:crypto";
import { invitationPublicApi, invitationControlApi } from "./invitations-api";
import { getPeopleInvitationService } from "./invitations-runtime";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getCurrentAuthSessionForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { peopleHome } from "@cocalc/server/people/common";
import { createInterBayCollaboratorsClient } from "@cocalc/conat/inter-bay/collaborators";
import * as history from "@cocalc/server/people/api";

jest.mock("./invitations-runtime", () => ({
  getPeopleInvitationService: jest.fn(),
}));
jest.mock("./invitations-discovery", () => ({
  resolveInvitationRecipientLocal: jest.fn(),
  listInvitationProjectsLocal: jest.fn(),
  inspectInvitationProject: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "sender-home",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: jest.fn(),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSessionForSessionHash: jest.fn(),
}));
jest.mock("@cocalc/server/people/common", () => ({ peopleHome: jest.fn() }));
jest.mock("@cocalc/server/people/api", () => ({
  listPeopleContacts: jest.fn(),
  getPeopleContact: jest.fn(),
  listInvitationHistory: jest.fn(),
  getPeopleInvitationCounts: jest.fn(),
}));

describe("live people invitation adapters", () => {
  const account_id = randomUUID();
  const send = jest.fn(),
    status = jest.fn();
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(getPeopleInvitationService)
      .mockReturnValue({ send, status } as any);
    jest
      .mocked(getServerSettings)
      .mockResolvedValue({ collaborators_enabled: true } as any);
    jest.mocked(peopleHome).mockResolvedValue("sender-home");
    jest
      .mocked(getCurrentAuthSessionForSessionHash)
      .mockResolvedValue({ account_id, session_hash: "verified" });
  });
  const input = () => ({
    account_id,
    draft_id: randomUUID(),
    revision: 1,
    review_id: randomUUID(),
    idempotency_key: randomUUID(),
    session_hash: "verified",
    route: { bay_id: "sender-home" },
  });
  it("dispatches the authenticated home request to the real service boundary", async () => {
    const opts = input();
    await invitationControlApi.sendInvitation(opts);
    expect(getCurrentAuthSessionForSessionHash).toHaveBeenCalledWith({
      account_id,
      session_hash: "verified",
    });
    expect(send).toHaveBeenCalledWith(account_id, opts, "verified");
  });
  it("rejects missing, forged, expired or revoked sessions before service execution", async () => {
    const opts = input();
    await expect(
      invitationControlApi.sendInvitation({
        ...opts,
        session_hash: undefined,
      } as any),
    ).rejects.toThrow("human session");
    jest
      .mocked(getCurrentAuthSessionForSessionHash)
      .mockRejectedValue(Error("current session revoked"));
    await expect(invitationControlApi.sendInvitation(opts)).rejects.toThrow(
      "revoked",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects stale routes rather than reading or writing a convenient local account", async () => {
    jest.mocked(peopleHome).mockResolvedValue("new-home");
    await expect(invitationControlApi.sendInvitation(input())).rejects.toThrow(
      "stale",
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("routes away from a receiving bay to the authoritative account home", async () => {
    const remote = {
      sendInvitation: jest.fn(async () => ({ operation_id: "durable" })),
    };
    jest
      .mocked(resolveAccountHomeBay)
      .mockResolvedValue({ home_bay_id: "remote-home" } as any);
    jest
      .mocked(createInterBayCollaboratorsClient)
      .mockReturnValue(remote as any);
    const { route: _route, ...opts } = input();
    expect(await invitationPublicApi.sendInvitation(opts)).toEqual({
      operation_id: "durable",
    });
    expect(remote.sendInvitation).toHaveBeenCalledWith({
      ...opts,
      route: { bay_id: "remote-home" },
    });
    expect(send).not.toHaveBeenCalled();
  });
  it("makes status read-only", async () => {
    const operation_id = randomUUID();
    await invitationControlApi.getInvitationOperation({
      account_id,
      operation_id,
      session_hash: "verified",
      route: { bay_id: "sender-home" },
    } as any);
    expect(status).toHaveBeenCalledWith(account_id, operation_id, "verified");
    expect(send).not.toHaveBeenCalled();
  });
  it("uses routed history storage, preserving account-private filters", async () => {
    const opts = {
      account_id,
      person_id: randomUUID(),
      view: "sent" as const,
      route: { bay_id: "sender-home" },
    };
    await invitationControlApi.listInvitationHistory(opts);
    expect(history.listInvitationHistory).toHaveBeenCalledWith(opts);
  });
  it("gates single-user Lite rather than simulating multiuser sends", async () => {
    const product = process.env.COCALC_PRODUCT;
    process.env.COCALC_PRODUCT = "lite";
    try {
      await expect(
        invitationControlApi.sendInvitation(input()),
      ).rejects.toThrow("unavailable");
    } finally {
      if (product === undefined) delete process.env.COCALC_PRODUCT;
      else process.env.COCALC_PRODUCT = product;
    }
    expect(send).not.toHaveBeenCalled();
  });
});
