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
export * from "./table-ownership";

// The tables
import "./active-user-map-history";
import "./account-managed-egress";
import "./account-collaborator-index";
import "./account-ban-audit-log";
import "./account-admin-audit-log";
import "./account-resource-quarantine-audit-log";
import "./account-notification-index";
import "./account-project-index";
import "./account-profiles";
import "./account-presence-locations";
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
import "./compute-resource-events";
import "./compute-resource-work";
import "./compute-egress-meter-intervals";
import "./compute-site-funded-usage";
import "./compute-vm-turn-grants";
import "./compute-vm-orphans";
import "./compute-vm-instances";
import "./compute-vms";
import "./compute-volumes";
import "./collaborators";
import "./crm";
import "./deleted-projects";
import "./email-counter";
import "./email-auth";
import "./external-credentials";
import "./global-config";
import "./growth-analytics";
import "./hub-servers";
import "./instances"; // probably deprecated
import "./listings";
import "./ai-log";
import "./lti";
import "./mentions";
import "./account-entitlement-overrides";
import "./admin-assigned-memberships";
import "./membership-analytics-daily-counts";
import "./membership-analytics-events";
import "./membership-allocation-facts";
import "./membership-allocation-projections";
import "./membership-daily-allocations";
import "./membership-grants";
import "./membership-claim-identities";
import "./membership-side-effects-outbox";
import "./membership-tiers";
import "./legacy-migration";
import "./messages";
import "./news";
import "./notification-events-outbox";
import "./notification-events";
import "./notification-email-outbox";
import "./notification-target-outbox";
import "./notification-targets";
import "./organizations";
import "./password-reset";
import "./pg-system";
import "./project-hosts";
import "./project-host-exam-configs";
import "./project-host-exam-runs";
import "./project-host-access";
import "./project-host-bootstrap-tokens";
import "./project-backup-repos";
import "./project-backup-indexes";
import "./project-collab-invites";
import "./project-entitlement-overrides";
import "./project-events-outbox";
import "./project-labels";
import "./project-host-route-invalidations";
import "./public-project-paths";
import "./project-rootfs-states";
import "./project-rootfs-builds";
import "./project-runtime-slots";
import "./projects";
import "./rootfs-image-events";
import "./rootfs-images";
import "./rootfs-release-artifacts";
import "./rootfs-release-scan-reports";
import "./rootfs-release-scan-runs";
import "./rootfs-releases";
import "./rootfs-rustic-repos";
import "./purchase-quotas";
import "./purchases";
import "./registration-tokens";
import "./retention";
import "./server-settings";
import "./self-host-commands";
import "./self-host-connector-tokens";
import "./self-host-connectors";
import "./site-settings";
import "./site-licenses";
import "./site-whitelabeling";
import "./software-licenses";
import "./sso";
import "./statements";
import "./stats";
import "./subscriptions";
import "./subscription-renewal-attempts";
import "./support-ticket-attempts";
import "./syncstring-schema";
import "./team-licenses";
import "./tracking";
import "./usage-info";
import "./webapp-errors";
import "./webapp-error-resolutions";

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
