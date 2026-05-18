import {
  normalizeSupportTicketOptions,
  normalizeZendeskBody,
  ticketResultToUserURL,
} from "./create-ticket";

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
