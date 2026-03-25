import { normalizeZendeskBody, ticketResultToUserURL } from "./create-ticket";

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
