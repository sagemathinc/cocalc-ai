import { ticketResultToUserURL } from "./create-ticket";

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
