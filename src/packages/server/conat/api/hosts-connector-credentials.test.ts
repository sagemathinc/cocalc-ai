/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { CLI_CONNECTOR_CREDENTIAL_KINDS } from "@cocalc/util/ai/cli-connectors";
import { normalizeExternalCredentialSelector } from "./hosts";

const owner_account_id = "00000000-0000-4000-8000-000000000001";

describe("generic host credential selectors", () => {
  it.each(CLI_CONNECTOR_CREDENTIAL_KINDS.map((kind) => [kind]))(
    "refuse connector kind %s, under any provider or spelling",
    (kind) => {
      for (const provider of ["github", "cloudflare", "openai"]) {
        for (const spelled of [kind, ` ${kind.toUpperCase()} `]) {
          expect(() =>
            normalizeExternalCredentialSelector({
              provider,
              kind: spelled,
              scope: "account",
              owner_account_id,
            }),
          ).toThrow("connector credentials are not available");
        }
      }
    },
  );

  it("still accept other kinds", () => {
    expect(() =>
      normalizeExternalCredentialSelector({
        provider: "openai",
        kind: "codex-subscription-auth-json",
        scope: "account",
        owner_account_id,
      }),
    ).not.toThrow();
  });
});
