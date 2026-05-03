import { shouldShowWrongAccountListingError } from "./listing-error";

describe("shouldShowWrongAccountListingError", () => {
  it("returns true for 403 permission errors", () => {
    expect(shouldShowWrongAccountListingError({ code: 403 })).toBe(true);
    expect(shouldShowWrongAccountListingError({ code: "403" })).toBe(true);
  });

  it("returns false for transient connection errors", () => {
    expect(shouldShowWrongAccountListingError({ code: 408 })).toBe(false);
    expect(shouldShowWrongAccountListingError({ code: "408" })).toBe(false);
  });

  it("returns false when no listing error is present", () => {
    expect(shouldShowWrongAccountListingError(undefined)).toBe(false);
  });
});
