/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  FUNDING_ROLLOUT_CHECKS,
  FUNDING_WRITER_PROTOCOL_VERSION,
} from "@cocalc/util/compute-funding-rollout";
import type { FundingRolloutEvidence } from "@cocalc/util/compute-funding-rollout";
import { registerFundingRolloutVerifier } from "../rollout";

export async function enableTestSponsorshipRollout(): Promise<() => void> {
  await getPool().query(
    `INSERT INTO server_settings(name,value)
     VALUES ('compute_sponsorship_enabled','yes')
     ON CONFLICT (name) DO UPDATE SET value=EXCLUDED.value`,
  );
  const unregister = FUNDING_ROLLOUT_CHECKS.map((check) =>
    registerFundingRolloutVerifier(check, async () => {
      const now = new Date();
      const evidence: FundingRolloutEvidence = {
        protocol_version: FUNDING_WRITER_PROTOCOL_VERSION,
        enforced: true,
        evidence_id: `integration-test:${check}`,
        as_of: now.toISOString(),
        expires_at: new Date(now.valueOf() + 60_000).toISOString(),
      };
      return evidence;
    }),
  );
  return () => unregister.reverse().forEach((fn) => fn());
}
