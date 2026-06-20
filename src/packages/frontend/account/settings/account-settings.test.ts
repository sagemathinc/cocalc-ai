/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Map } from "immutable";

import { getAccountPassportNames } from "./account-settings";

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
