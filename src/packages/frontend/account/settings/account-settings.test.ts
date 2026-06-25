/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";

import {
  editableDisplayNameValue,
  getAccountPassportNames,
} from "./account-settings";

describe("account settings SSO passport helpers", () => {
  it("ignores null passport tombstones", () => {
    expect(
      getAccountPassportNames(
        Map({
          "google-active-id": { id: "active-id" },
          "google-deleted-id": null,
        }),
      ),
    ).toEqual(["google"]);
  });
});

describe("editable display name value", () => {
  it("preserves raw display_name while editing", () => {
    expect(
      editableDisplayNameValue({
        display_name: "Admin ",
        first_name: "Admin",
        last_name: "User",
      }),
    ).toBe("Admin ");
  });

  it("derives an initial value from legacy name parts", () => {
    expect(
      editableDisplayNameValue({
        first_name: "Ada",
        last_name: "Lovelace",
      }),
    ).toBe("Ada Lovelace");
  });
});
