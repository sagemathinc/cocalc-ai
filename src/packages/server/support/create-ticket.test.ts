import createTicket, {
  normalizeSupportTicketOptions,
  normalizeZendeskBody,
  ticketResultToUserURL,
  supportContentConsentRecord,
} from "./create-ticket";

const mockCreate = jest.fn(async (_ticket: any) => ({
  result: { url: "https://sagemathcloud.zendesk.com/api/v2/tickets/123.json" },
}));
jest.mock("./zendesk-client", () => ({
  __esModule: true,
  default: async () => ({ tickets: { create: mockCreate } }),
}));
jest.mock("./rate-limit", () => ({
  assertSupportTicketRateLimit: jest.fn(async () => {}),
}));
jest.mock("@cocalc/server/accounts/get-name", () => ({
  __esModule: true,
  default: async () => "Test User",
  getNameByEmail: async () => "Test User",
}));

it.each([true, false, undefined])(
  "persists consent %p in the Zendesk submission",
  async (consent) => {
    mockCreate.mockClear();
    await createTicket({
      email: "user@example.com",
      subject: "Help with files",
      body: "Please investigate this issue",
      support_content_consent: consent,
    });
    const payload = mockCreate.mock.calls[0][0].ticket;
    expect(payload.tags).toEqual([
      consent === true
        ? "support_content_consent_yes"
        : "support_content_consent_no",
    ]);
    expect(payload.comment.body).toContain(`"consent":${consent === true}`);
    expect(payload.comment.body).toContain(
      "Inspection is not limited to files you select",
    );
  },
);

jest.mock("@cocalc/database/settings/site-url", () => ({
  __esModule: true,
  default: jest.fn(async () => "https://lite4.cocalc.ai"),
}));

describe("ticketResultToUserURL", () => {
  it("extracts the Zendesk ticket URL from the nested result payload", () => {
    expect(
      ticketResultToUserURL({
        result: {
          url: "https://sagemathcloud.zendesk.com/api/v2/tickets/19598.json",
        },
      }),
    ).toBe("https://sagemathcloud.zendesk.com/requests/19598");
  });

  it("still supports the older top-level url shape", () => {
    expect(
      ticketResultToUserURL({
        url: "https://sagemathcloud.zendesk.com/api/v2/tickets/19599.json",
      }),
    ).toBe("https://sagemathcloud.zendesk.com/requests/19599");
  });
});

describe("normalizeZendeskBody", () => {
  it("rewrites blob img tags to absolute image links", async () => {
    expect(
      await normalizeZendeskBody(
        '<img src="/blobs/paste.png?uuid=123" width="10" />',
      ),
    ).toContain("- Image: https://lite4.cocalc.ai/blobs/paste.png?uuid=123");
  });

  it("rewrites markdown image syntax to absolute image links", async () => {
    expect(
      await normalizeZendeskBody("![](/blobs/paste-two.png?uuid=456)"),
    ).toContain(
      "- Image: https://lite4.cocalc.ai/blobs/paste-two.png?uuid=456",
    );
  });
});

describe("normalizeSupportTicketOptions", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  it("accepts only explicit boolean consent, never coerces strings", () => {
    const options = {
      email: "user@example.com",
      subject: "Need help",
      body: "A detailed support request",
    };
    for (const value of [true, false]) {
      expect(
        normalizeSupportTicketOptions({
          ...options,
          support_content_consent: value,
        }).support_content_consent,
      ).toBe(value);
    }
    expect(
      normalizeSupportTicketOptions(options).support_content_consent,
    ).toBeUndefined();
    for (const value of ["true", "false", 1, {}]) {
      expect(() =>
        normalizeSupportTicketOptions({
          ...options,
          support_content_consent: value as any,
        }),
      ).toThrow("must be a boolean");
    }
  });

  it("records the consent version, scope, account and explicit non-consent", () => {
    const record = supportContentConsentRecord(false, project_id);
    expect(record).toContain('"consent":false');
    expect(record).toContain('"version":"2026-09-08"');
    expect(record).toContain(`"authenticated_account_id":"${project_id}"`);
    expect(record).toContain("Do not infer consent");
    expect(supportContentConsentRecord(true)).toContain(
      '"authenticated_account_id":null',
    );
    expect(supportContentConsentRecord(true)).toContain(
      "Confirm identity, scope, and any later withdrawal",
    );
  });

  it("normalizes public support ticket inputs", () => {
    expect(
      normalizeSupportTicketOptions({
        email: " USER@Example.COM ",
        subject: " Help with a project ",
        body: " I cannot start my project. ",
        url: " https://cocalc.example/support ",
        files: [{ project_id, path: " foo.ipynb " }],
        info: {
          browser: " Firefox ",
          userAgent: " Mozilla/5.0 ",
          context: " project-settings ",
        },
      }),
    ).toEqual({
      email: "user@example.com",
      subject: "Help with a project",
      body: "I cannot start my project.",
      url: "https://cocalc.example/support",
      files: [{ project_id, path: "foo.ipynb" }],
      info: {
        browser: "Firefox",
        userAgent: "Mozilla/5.0",
        context: "project-settings",
      },
    });
  });

  it("rejects invalid email addresses", () => {
    expect(() =>
      normalizeSupportTicketOptions({
        email: "not-an-email",
        subject: "Help with a project",
        body: "I cannot start my project.",
      }),
    ).toThrow("email must be valid");
  });

  it("rejects oversized ticket bodies", () => {
    expect(() =>
      normalizeSupportTicketOptions({
        email: "user@example.com",
        subject: "Help with a project",
        body: "x".repeat(20_001),
      }),
    ).toThrow("body must be between");
  });

  it("rejects too many files", () => {
    expect(() =>
      normalizeSupportTicketOptions({
        email: "user@example.com",
        subject: "Help with a project",
        body: "I cannot start my project.",
        files: Array.from({ length: 6 }, () => ({ project_id })),
      }),
    ).toThrow("files must contain at most 5 files");
  });

  it("rejects invalid file project ids", () => {
    expect(() =>
      normalizeSupportTicketOptions({
        email: "user@example.com",
        subject: "Help with a project",
        body: "I cannot start my project.",
        files: [{ project_id: "not-a-uuid" }],
      }),
    ).toThrow("project_id must be a valid uuid");
  });
});
