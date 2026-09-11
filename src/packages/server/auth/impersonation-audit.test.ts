import {
  createImpersonationGrantLocal,
  createImpersonationSessionLocal,
} from "./impersonation";
import centralLog from "@cocalc/database/postgres/central-log";

const mockQuery = jest.fn(async (_sql: string, _params?: any[]) => ({
  rows: [],
}));
jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: jest.fn(async () => {}),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-test",
}));
jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHash: jest.fn(),
}));
jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  assertAccountWriteOnHomeBay: jest.fn(async () => {}),
  withAccountRehomeWriteFence: async ({ fn }: any) => fn({ query: mockQuery }),
}));

const options = {
  actor_account_id: "11111111-1111-4111-8111-111111111111",
  subject_account_id: "22222222-2222-4222-8222-222222222222",
  actor_session_hash: "actor-session",
  subject_home_bay_id: "bay-test",
  reason: " Investigate ticket 123 with explicit permission ",
  metadata: {
    support_ticket_id: 123,
    consent_reference: "Customer comment 456; operator approved",
    created_via: "support-cli",
  },
};

beforeEach(() => {
  jest.clearAllMocks();
});

it("retains reason and support consent reference in grant, session, and audit events", async () => {
  const grant = await createImpersonationGrantLocal(options);
  expect(grant.reason).toBe(options.reason.trim());
  expect(mockQuery.mock.calls[0][1]).toEqual(
    expect.arrayContaining([
      options.reason.trim(),
      JSON.stringify(options.metadata),
    ]),
  );
  expect(centralLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "impersonation-grant-created",
      value: expect.objectContaining({
        reason: options.reason.trim(),
        support_ticket_id: 123,
        consent_reference: options.metadata.consent_reference,
        actor_account_id: options.actor_account_id,
        subject_account_id: options.subject_account_id,
      }),
    }),
  );
  await createImpersonationSessionLocal({
    session_hash: "subject-session",
    expire: new Date(Date.now() + 60000),
    grant,
  });
  expect(mockQuery.mock.calls[1][1]).toEqual(
    expect.arrayContaining([
      options.reason.trim(),
      JSON.stringify(options.metadata),
    ]),
  );
  expect(centralLog).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "impersonation-session-created",
      value: expect.objectContaining({
        reason: options.reason.trim(),
        support_ticket_id: 123,
        consent_reference: options.metadata.consent_reference,
      }),
    }),
  );
});

it("rejects missing reasons before writing a grant", async () => {
  await expect(
    createImpersonationGrantLocal({ ...options, reason: undefined }),
  ).rejects.toThrow("reason is required");
  expect(mockQuery).not.toHaveBeenCalled();
  expect(centralLog).not.toHaveBeenCalled();
});
