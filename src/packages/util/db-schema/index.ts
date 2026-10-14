/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export { SCHEMA } from "./types";
export type {
  DBSchema,
  TableSchema,
  FieldSpec,
  PgTableConstraint,
  UserOrProjectQuery,
} from "./types";
export type { RenderSpec } from "./render-types";
export type { RetentionModel } from "./retention";
export { retentionModels } from "./retention";
export * from "./table-ownership";
export * from "./domain-api-only";

// The tables
import "./account-collaborator-index";
import "./account-ban-audit-log";
import "./account-admin-audit-log";
import "./account-resource-quarantine-audit-log";
import "./account-notification-index";
import "./account-project-index";
import "./account-profiles";
import "./accounts";
import "./blobs";
import "./bookmarks";
import "./central-log";
import "./client-error-log";
import "./collaborators";
import "./listings";
import "./ai-log";
import "./lti";
import "./mentions";
import "./account-entitlement-overrides";
import "./admin-assigned-memberships";
import "./membership-grants";
import "./membership-claim-identities";
import "./membership-tiers";
import "./legacy-migration";
import "./messages";
import "./news";
import "./organizations";
import "./pg-system";
import "./project-archive-lifecycle-jobs";
import "./project-entitlement-overrides";
import "./public-project-paths";
import "./projects";
import "./purchase-quotas";
import "./purchases";
import "./registration-tokens";
import "./retention";
import "./server-settings";
import "./site-settings";
import "./site-licenses";
import "./site-whitelabeling";
import "./sso";
import "./statements";
import "./subscriptions";
import "./syncstring-schema";
import "./team-licenses";
import "./tracking";
import "./usage-info";

// Tables only the server uses: the browser build leaves them out (see
// server-tables.ts).
import "./server-tables";

export {
  DEFAULT_FONT_SIZE,
  NEW_FILENAMES,
  DEFAULT_NEW_FILENAMES,
} from "./defaults";

export * from "./operators";
export type { Operator } from "./operators";

export { site_settings_conf } from "./site-defaults";
export {
  PUBLIC_SITE_SETTINGS_KEYS,
  buildPublicSiteSettings,
  isPublicSiteSettingKey,
} from "./site-settings-public";

export { client_db } from "./client-db";
