/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import * as localLegacyMigration from "@cocalc/server/legacy-migration";
import type {
  LegacyMigrationApplyFinancialOptions,
  LegacyMigrationConfigureFinancialRenewalOptions,
  LegacyMigrationFinancialPreviewOptions,
  LegacyMigrationImportProjectsOptions,
  LegacyMigrationListProjectsOptions,
  LegacyMigrationRetryProjectRestoreOptions,
} from "@cocalc/conat/hub/api/legacy-migration";

function getSeedBayId(): string {
  return getConfiguredClusterSeedBayId();
}

function isSeedBay(): boolean {
  return getConfiguredBayId() === getSeedBayId();
}

function getSeedLegacyMigrationClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getSeedBayId(),
  });
}

export async function listProjects(opts?: LegacyMigrationListProjectsOptions) {
  return isSeedBay()
    ? await localLegacyMigration.listProjects(opts ?? {})
    : await getSeedLegacyMigrationClient().legacyMigrationListProjects(
        opts ?? {},
      );
}

export async function importProjects(
  opts: LegacyMigrationImportProjectsOptions,
) {
  return isSeedBay()
    ? await localLegacyMigration.importProjects(opts)
    : await getSeedLegacyMigrationClient().legacyMigrationImportProjects(opts);
}

export async function retryProjectRestore(
  opts: LegacyMigrationRetryProjectRestoreOptions,
) {
  return isSeedBay()
    ? await localLegacyMigration.retryProjectRestore(opts)
    : await getSeedLegacyMigrationClient().legacyMigrationRetryProjectRestore(
        opts,
      );
}

export async function previewFinancialMigration(
  opts?: LegacyMigrationFinancialPreviewOptions,
) {
  return isSeedBay()
    ? await localLegacyMigration.previewFinancialMigration(opts)
    : await getSeedLegacyMigrationClient().legacyMigrationPreviewFinancialMigration(
        opts ?? {},
      );
}

export async function applyFinancialMigration(
  opts?: LegacyMigrationApplyFinancialOptions,
) {
  return isSeedBay()
    ? await localLegacyMigration.applyFinancialMigration(opts)
    : await getSeedLegacyMigrationClient().legacyMigrationApplyFinancialMigration(
        opts ?? {},
      );
}

export async function configureFinancialMembershipRenewal(
  opts?: LegacyMigrationConfigureFinancialRenewalOptions,
) {
  return await localLegacyMigration.configureFinancialMembershipRenewal(
    opts ?? {},
  );
}
