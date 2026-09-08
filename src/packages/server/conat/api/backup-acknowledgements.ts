/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { assertCollab } from "./util";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { backupAcknowledgementsLocal } from "@cocalc/server/project-backup/acknowledgements";
import {
  validateBackupAcknowledgementKeys,
  validateBackupAcknowledgementScope,
} from "@cocalc/util/backup-acknowledgements";
import type { BackupAcknowledgementRequest } from "@cocalc/util/backup-acknowledgements";

export async function backupWarningAcknowledgements({
  account_id,
  project_id,
  key,
  scope,
  remove,
}: Omit<BackupAcknowledgementRequest, "account_id"> & {
  account_id?: string;
}): Promise<string[]> {
  if (!account_id) throw new Error("Sign in to acknowledge backup warnings");
  if (key !== undefined) validateBackupAcknowledgementKeys([key]);
  validateBackupAcknowledgementScope(scope);
  await assertCollab({ account_id, project_id });
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const opts = { account_id, project_id, key, scope, remove };
  const result =
    location.home_bay_id === getConfiguredBayId()
      ? await backupAcknowledgementsLocal(opts)
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: location.home_bay_id,
        }).backupWarningAcknowledgements(opts);
  return validateBackupAcknowledgementKeys(result);
}
