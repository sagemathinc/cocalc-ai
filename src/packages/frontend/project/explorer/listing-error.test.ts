import { shouldShowWrongAccountListingError } from "./listing-error";

describe("shouldShowWrongAccountListingError", () => {
  it("returns true for 403 permission errors", () => {
    expect(shouldShowWrongAccountListingError({ code: 403 })).toBe(true);
    expect(shouldShowWrongAccountListingError({ code: "403" })).toBe(true);
    expect(
      shouldShowWrongAccountListingError({
        code: "403",
        message: "permission denied",
      }),
    ).toBe(true);
  });

  it("returns false for transient connection errors", () => {
    expect(shouldShowWrongAccountListingError({ code: 408 })).toBe(false);
    expect(shouldShowWrongAccountListingError({ code: "408" })).toBe(false);
  });

  it("returns false for transient project-host auth cooldown errors", () => {
    expect(
      shouldShowWrongAccountListingError({
        code: "403",
        message:
          "failed to sign in - Error: too many authentication failures from ip:1.2.3.4; retry in about 51s",
      }),
    ).toBe(false);
  });

  it("returns false for transient project-host bootstrap errors", () => {
    expect(
      shouldShowWrongAccountListingError({
        code: "403",
        message: "failed to sign in - Error: missing project-host bearer token",
      }),
    ).toBe(false);
    expect(
      shouldShowWrongAccountListingError({
        code: "403",
        message: 'once: "inbox" not emitted before "closed"',
      }),
    ).toBe(false);
  });

  it("returns false when no listing error is present", () => {
    expect(shouldShowWrongAccountListingError(undefined)).toBe(false);
  });
});
