/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import os from "node:os";
import { join } from "node:path";

import { after, before } from "@cocalc/server/test";
import getPool from "@cocalc/database/pool";
import createAccount from "@cocalc/server/accounts/create-account";
import { uuid } from "@cocalc/util/misc";

const mockGetStrategies = jest.fn();

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: (...args) => mockGetStrategies(...args),
}));

beforeAll(async () => {
  process.env.COCALC_SECRET_SETTINGS_KEY_PATH = join(
    os.tmpdir(),
    `cocalc-secret-settings-key-${uuid()}`,
  );
  await before({ noConat: true });
}, 15000);

afterAll(after);

describe("setEmailAddress", () => {
  beforeEach(() => {
    mockGetStrategies.mockReset().mockResolvedValue([]);
  });

  it("does not set a password when the current email requires SSO", async () => {
    const account_id = uuid();
    await createAccount({
      email: `${uuid()}@example.edu`,
      firstName: "SSO",
      lastName: "Only",
      account_id,
    });
    mockGetStrategies.mockResolvedValue([
      {
        name: "google",
        display: "Google",
        backgroundColor: "#fff",
        public: true,
        exclusiveDomains: ["example.edu"],
        doNotHide: false,
      },
    ]);

    const { default: setEmailAddress } = await import("./set-email-address");

    await expect(
      setEmailAddress({
        account_id,
        email_address: `${uuid()}@new.example`,
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("You are not allowed to change your email address");

    const { rows } = await getPool().query(
      "SELECT password_hash FROM accounts WHERE account_id=$1::UUID",
      [account_id],
    );
    expect(rows[0].password_hash).toBeNull();
  });
});
