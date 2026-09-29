/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { invitationPublicApi, invitationControlApi } from "./invitations-api";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const mockSettings = jest.fn();
const mockHome = jest.fn();
const mockPeopleHome = jest.fn();
const mockResolve = jest.fn();
const mockProjects = jest.fn();
const mockOwner = jest.fn();
const mockClient = jest.fn();
const mockLocal = {
  resolveInvitationRecipient: jest.fn(),
  listInvitationProjects: jest.fn(),
};
const mockRemote = {
  resolveInvitationRecipient: jest.fn(),
  listInvitationProjects: jest.fn(),
};
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "local",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (opts) => mockHome(opts),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => mockSettings(),
}));
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: (opts) => mockClient(opts),
}));
jest.mock("@cocalc/server/people/api", () => ({}));
jest.mock("@cocalc/server/people/common", () => ({
  peopleHome: (id) => mockPeopleHome(id),
}));
jest.mock("./invitations-runtime", () => ({
  getPeopleInvitationService: jest.fn(),
}));
jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSessionForSessionHash: jest.fn(),
}));
jest.mock("./api", () => ({ collaboratorsControl: mockLocal }));
jest.mock("./invitations-discovery", () => ({
  resolveInvitationRecipientLocal: (input) => mockResolve(input),
  listInvitationProjectsLocal: (input) => mockProjects(input),
  inspectInvitationProject: (input) => mockOwner(input),
}));

const requests = [
  {
    name: "resolveInvitationRecipient" as const,
    input: { query: "Ada" },
    local: mockResolve,
  },
  {
    name: "listInvitationProjects" as const,
    input: {
      recipient: { kind: "email" as const, email_address: "ada@example.test" },
      query: "Algebra",
      cursor: "next",
    },
    local: mockProjects,
  },
];
beforeEach(() => {
  jest.resetAllMocks();
  mockSettings.mockResolvedValue({ collaborators_enabled: true });
  mockHome.mockResolvedValue({ home_bay_id: "remote" });
  mockPeopleHome.mockResolvedValue("local");
  mockClient.mockReturnValue(mockRemote);
});

test.each(requests)(
  "$name routes by explicit account home and preserves recipient/query/cursor",
  async ({ name, input }) => {
    mockRemote[name].mockResolvedValue({ marker: "remote result" });
    await expect(
      (invitationPublicApi[name] as (input: unknown) => Promise<unknown>)({
        ...input,
        account_id: ACCOUNT,
      }),
    ).resolves.toEqual({ marker: "remote result" });
    expect(mockHome).toHaveBeenCalledWith({ account_id: ACCOUNT });
    expect(mockClient).toHaveBeenCalledWith({
      client: "fabric",
      bay_id: "remote",
    });
    expect(mockRemote[name]).toHaveBeenCalledWith({
      ...input,
      account_id: ACCOUNT,
      route: { bay_id: "remote" },
    });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockProjects).not.toHaveBeenCalled();
  },
);

test.each(requests)(
  "$name uses the same control contract for one-bay deployments",
  async ({ name, input }) => {
    mockHome.mockResolvedValue({ home_bay_id: "local" });
    await (invitationPublicApi[name] as (input: unknown) => Promise<unknown>)({
      ...input,
      account_id: ACCOUNT,
    });
    expect(mockLocal[name]).toHaveBeenCalledWith({
      ...input,
      account_id: ACCOUNT,
      route: { bay_id: "local" },
    });
    expect(mockClient).not.toHaveBeenCalled();
  },
);

test.each(requests)(
  "$name rejects stale home routing before private discovery",
  async ({ name, input, local }) => {
    mockPeopleHome.mockResolvedValue("new-home");
    await expect(
      (invitationControlApi[name] as (input: unknown) => Promise<unknown>)({
        ...input,
        account_id: ACCOUNT,
        route: { bay_id: "local" },
      }),
    ).rejects.toThrow("account-home");
    expect(local).not.toHaveBeenCalled();
  },
);

test.each(requests)(
  "$name control delegates only after local ownership is resolved",
  async ({ name, input, local }) => {
    await (invitationControlApi[name] as (input: unknown) => Promise<unknown>)({
      ...input,
      account_id: ACCOUNT,
      route: { bay_id: "local" },
    });
    expect(local).toHaveBeenCalledWith({
      ...input,
      account_id: ACCOUNT,
      route: { bay_id: "local" },
    });
  },
);

test("owner inspection remains private to the control API", () => {
  expect(invitationControlApi).toHaveProperty("inspectInvitationProject");
  expect(invitationPublicApi).not.toHaveProperty("inspectInvitationProject");
});
