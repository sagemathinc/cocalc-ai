/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseProtocolCompatibility } from "./protocol";

const compatible = {
  protocol_version: 1 as const,
  app_base_path: "",
  browser_challenge_login: 1 as const,
  project_window: 1 as const,
  project_host_routing: 1 as const,
  chat_sync: 2 as const,
  agent_session_index: 1 as const,
  acp: 1 as const,
};

test("accepts the advertised native protocol", () => {
  assert.deepEqual(
    parseProtocolCompatibility({ client_capabilities: compatible }),
    { capabilities: compatible, legacy: false },
  );
});

test("makes an explicit legacy-server fallback", () => {
  const result = parseProtocolCompatibility({ signed_in: false });
  assert.equal(result.legacy, true);
  assert.match(result.warning ?? "", /predates native-client/);
});

test("reports a server upgrade for an incompatible chat schema", () => {
  assert.throws(
    () =>
      parseProtocolCompatibility({
        client_capabilities: { ...compatible, chat_sync: 1 },
      }),
    /server upgrade is required/i,
  );
});
