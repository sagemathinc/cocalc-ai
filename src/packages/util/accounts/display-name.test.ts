import {
  displayNameFromAccount,
  legacyNamePartsFromAccount,
  legacyNamePartsFromDisplayName,
  normalizeDisplayName,
} from "./display-name";

describe("account display names", () => {
  it("normalizes whitespace and length", () => {
    expect(normalizeDisplayName("  Ada   Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeDisplayName("x".repeat(300))).toHaveLength(254);
  });

  it("prefers display_name over legacy split names", () => {
    expect(
      displayNameFromAccount({
        display_name: "AdmiN",
        first_name: "Admin",
        last_name: "User",
      }),
    ).toBe("AdmiN");
  });

  it("derives legacy split names from the canonical display name", () => {
    expect(
      legacyNamePartsFromAccount({
        display_name: "AdmiN",
        first_name: "Admin",
        last_name: "User",
      }),
    ).toEqual({ first_name: "AdmiN", last_name: "" });
    expect(legacyNamePartsFromDisplayName("Ada Lovelace")).toEqual({
      first_name: "Ada",
      last_name: "Lovelace",
    });
  });
});
