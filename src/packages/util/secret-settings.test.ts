/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { EXTRAS } from "./db-schema/site-settings-extras";
import { site_settings_conf } from "./db-schema/site-defaults";
import { isSecretSetting, RETIRED_SECRET_SETTINGS } from "./secret-settings";

describe("isSecretSetting", () => {
  it("keeps a retired secret setting secret after its definition is removed", () => {
    // github_token's stored row may remain until a deploy deletes it; it must
    // still be decrypted and re-encrypted by master-key rotation.
    expect(RETIRED_SECRET_SETTINGS.has("github_token")).toBe(true);
    expect((EXTRAS as any).github_token).toBeUndefined();
    expect((site_settings_conf as any).github_token).toBeUndefined();
    expect(isSecretSetting("github_token")).toBe(true);
  });

  it("classifies defined settings by their password flag", () => {
    expect(isSecretSetting("github_connector_client_secret")).toBe(true);
    expect(isSecretSetting("github_connector_client_id")).toBe(false);
    expect(isSecretSetting("no_such_setting")).toBe(false);
  });

  it("no longer defines the other removed GitHub proxy settings", () => {
    for (const name of [
      "github_heading",
      "github_project_id",
      "github_username",
      "github_block",
    ]) {
      expect((EXTRAS as any)[name]).toBeUndefined();
      expect(isSecretSetting(name)).toBe(false);
    }
  });
});
