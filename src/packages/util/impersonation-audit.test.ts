import {
  impersonationReason,
  impersonationSupportContext,
} from "./impersonation-audit";

describe("impersonation audit context", () => {
  test.each([undefined, null, "", " \n ", 42, {}, "x".repeat(513)])(
    "rejects invalid reasons: %p",
    (value) => {
      expect(() => impersonationReason(value)).toThrow();
    },
  );
  it("preserves the full reason without silent truncation", () => {
    expect(impersonationReason(" Ticket 123: consent in customer reply ")).toBe(
      "Ticket 123: consent in customer reply",
    );
    expect(impersonationReason("x".repeat(512))).toHaveLength(512);
  });
  test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid ticket ids: %p",
    (support_ticket_id) => {
      expect(() =>
        impersonationSupportContext({
          support_ticket_id,
          consent_reference: "customer reply",
        }),
      ).toThrow();
    },
  );
  it("requires a consent reference for support and retains it as structured context", () => {
    expect(() =>
      impersonationSupportContext({ support_ticket_id: 123 }),
    ).toThrow("consent reference");
    expect(() =>
      impersonationSupportContext({
        support_ticket_id: 123,
        consent_reference: " ",
      }),
    ).toThrow();
    expect(
      impersonationSupportContext({
        support_ticket_id: 123,
        consent_reference: " approved in reply ",
      }),
    ).toEqual({
      support_ticket_id: 123,
      consent_reference: "approved in reply",
    });
    expect(impersonationSupportContext({})).toEqual({
      support_ticket_id: undefined,
      consent_reference: undefined,
    });
  });
});
