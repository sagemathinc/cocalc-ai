/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tables only the server uses: no user or project query reaches them from a
// browser. index.ts imports this module, so Node (the hub, the database,
// tests) always registers every table. The browser build replaces it with
// server-tables-browser.ts (static/src/plugins/server-only-tables.ts), which
// keeps their definitions out of every page.
//
// server-tables.test.ts keeps this list honest: a table defined here must
// have no user_query or project_query, and index.ts must not import a module
// that defines only server-side tables.

import "./account-managed-egress";
import "./account-presence-locations";
import "./account-usernames";
import "./active-user-map-history";
import "./admin-membership-orders";
import "./admin-membership-package-intents";
import "./agent-external";
import "./agent-messaging";
import "./agent-personal";
import "./agent-sensors";
import "./api-keys";
import "./artifact-catalog";
import "./auth";
import "./billing-accounts";
import "./billing-authority";
import "./buckets";
import "./cloud-catalog-cache";
import "./cloud-pricing-cache";
import "./cloud-reconcile-state";
import "./cloud-vm-log";
import "./cloud-vm-usage";
import "./cloud-vm-work";
import "./commercial-orders";
import "./compute-egress-meter-intervals";
import "./compute-funding";
import "./computers";
import "./compute-resource-events";
import "./compute-resource-work";
import "./compute-revenue-analytics-state";
import "./admin-alert-state";
import "./compute-revenue-daily";
import "./compute-site-funded-usage";
import "./compute-usage-daily";
import "./compute-vm-funding";
import "./compute-vm-instances";
import "./compute-vm-orphans";
import "./compute-vm-project-access";
import "./compute-vm-turn-grants";
import "./compute-vms";
import "./compute-volumes";
import "./credit-transfers";
import "./crm";
import "./crm-outreach";
import "./deleted-projects";
import "./email-auth";
import "./email-counter";
import "./external-credentials";
import "./global-config";
import "./growth-analytics";
import "./hub-servers";
import "./instances"; // probably deprecated
import "./membership-allocation-facts";
import "./membership-allocation-projections";
import "./membership-analytics-daily-counts";
import "./membership-analytics-events";
import "./membership-daily-allocations";
import "./membership-side-effects-outbox";
import "./notification-email-outbox";
import "./notification-events";
import "./notification-events-outbox";
import "./notification-target-outbox";
import "./notification-targets";
import "./oauth";
import "./password-reset";
import "./payment-fulfillments";
import "./people";
import "./personal-library";
import "./project-backup-indexes";
import "./project-backup-repos";
import "./project-collab-invites";
import "./project-events-outbox";
import "./project-host-access";
import "./project-host-bootstrap-tokens";
import "./project-host-exam-configs";
import "./project-host-exam-runs";
import "./project-host-route-invalidations";
import "./project-hosts";
import "./project-labels";
import "./project-rootfs-builds";
import "./project-rootfs-states";
import "./project-runtime-slots";
import "./provider-refund-attempts";
import "./rootfs-image-events";
import "./rootfs-images";
import "./rootfs-release-artifacts";
import "./rootfs-release-scan-reports";
import "./rootfs-release-scan-runs";
import "./rootfs-releases";
import "./rootfs-rustic-repos";
import "./self-host-commands";
import "./self-host-connector-tokens";
import "./self-host-connectors";
import "./site-ai-funding";
import "./software-licenses";
import "./stats";
import "./subscription-renewal-attempts";
import "./support-ticket-attempts";
import "./webapp-error-resolutions";
import "./webapp-errors";
