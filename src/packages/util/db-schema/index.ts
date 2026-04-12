/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export { SCHEMA } from "./types";
export type {
  DBSchema,
  TableSchema,
  FieldSpec,
  UserOrProjectQuery,
} from "./types";
export type { RenderSpec } from "./render-types";
export type { RetentionModel } from "./retention";
export { retentionModels } from "./retention";

// The tables
import "./account-creation-actions";
import "./account-collaborator-index";
import "./account-notification-index";
import "./account-project-index";
import "./account-profiles";
import "./accounts";
import "./api-keys";
import "./auth";
import "./blobs";
import "./bookmarks";
import "./buckets";
import "./central-log";
import "./client-error-log";
import "./cloud-catalog-cache";
import "./cloud-pricing-cache";
import "./cloud-reconcile-state";
import "./cloud-vm-log";
import "./cloud-vm-usage";
import "./cloud-vm-work";
import "./collaborators";
import "./crm";
import "./deleted-projects";
import "./email-counter";
import "./external-credentials";
import "./file-access-log";
import "./groups";
import "./hub-servers";
import "./instances"; // probably deprecated
import "./listings";
import "./llm";
import "./lti";
import "./mentions";
import "./admin-assigned-memberships";
import "./membership-tiers";
import "./messages";
import "./news";
import "./notification-events-outbox";
import "./notification-events";
import "./notification-target-outbox";
import "./notification-targets";
import "./organizations";
import "./password-reset";
import "./pg-system";
import "./project-invite-tokens";
import "./project-hosts";
import "./project-host-bootstrap-tokens";
import "./project-backup-repos";
import "./project-collab-invites";
import "./project-events-outbox";
import "./project-rootfs-states";
import "./projects";
import "./rootfs-image-events";
import "./rootfs-images";
import "./rootfs-release-artifacts";
import "./rootfs-releases";
import "./public-path-stars";
import "./public-paths";
import "./purchase-quotas";
import "./purchases";
import "./registration-tokens";
import "./retention";
import "./server-settings";
import "./self-host-commands";
import "./self-host-connector-tokens";
import "./self-host-connectors";
import "./shopping-cart-items";
import "./site-settings";
import "./site-whitelabeling";
import "./software-licenses";
import "./statements";
import "./stats";
import "./subscriptions";
import "./syncstring-schema";
import "./tracking";
import "./usage-info";
import "./vouchers";
import "./webapp-errors";

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
