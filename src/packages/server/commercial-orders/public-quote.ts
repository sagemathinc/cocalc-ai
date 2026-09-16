/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { assertCommercialReceivablesCapability } from "./feature-flags";

export interface PublicQuotePdf {
  filename: string;
  content_base64: string;
}

function unavailable(): never {
  throw Object.assign(Error("Quote download unavailable"), { code: 404 });
}

// Narrow bearer-capability API: never returns order, account or provider metadata.
export async function downloadPublicQuote(
  token: string,
): Promise<PublicQuotePdf> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) unavailable();
  const seed = getConfiguredClusterSeedBayId();
  if (getConfiguredBayId() !== seed) {
    return await getInterBayBridge()
      .bayOps(seed, { timeout_ms: 30_000 })
      .downloadCommercialQuoteInternal({ token });
  }
  await assertCommercialReceivablesCapability("visible");
  const digest = createHash("sha256").update(token).digest("hex");
  // Atomic per-link limit shared by all hubs/bays. Invalid tokens create no rows.
  const { rows } = await getPool().query(
    `UPDATE commercial_quotes SET
       download_window_count=CASE WHEN download_window_at > NOW()-INTERVAL '1 minute'
         THEN download_window_count+1 ELSE 1 END,
       download_window_at=CASE WHEN download_window_at > NOW()-INTERVAL '1 minute'
         THEN download_window_at ELSE NOW() END
     WHERE download_token_hash=$1 AND download_expires_at>NOW() AND valid_until>NOW()
       AND status IN ('issued','accepted') AND document_data IS NOT NULL
       AND octet_length(document_data)<=2097152
       AND (download_window_at IS NULL OR download_window_at<=NOW()-INTERVAL '1 minute'
            OR download_window_count<20)
     RETURNING document_data,document_sha256,document_filename`,
    [digest],
  );
  const row = rows[0];
  // Unavailable, expired, revoked and throttled links all have the same response.
  if (!row || !Buffer.isBuffer(row.document_data)) unavailable();
  if (
    createHash("sha256").update(row.document_data).digest("hex") !==
    row.document_sha256
  )
    unavailable();
  return {
    filename: row.document_filename,
    content_base64: row.document_data.toString("base64"),
  };
}
