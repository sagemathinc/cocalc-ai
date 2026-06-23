/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type DangerousRpcFreshAuthDecision =
  | "fresh-auth-required"
  | "fresh-auth-not-required"
  | "internal-auth-only";

export type DangerousRpcDecision = {
  decision: DangerousRpcFreshAuthDecision;
  reason: string;
};

const INTERNAL_AUTH_ONLY = "trusted in-process or host/inter-bay caller only";
const ORDINARY_AUTHZ =
  "ordinary endpoint authorization is the intended gate; fresh auth is not required";
const TELEMETRY_ONLY =
  "telemetry/status/update endpoint; not a human destructive action";

// This registry is intentionally explicit.  The companion regression test scans
// public hub API exports with destructive/admin-looking names and fails until
// new RPCs are added here with a fresh-auth decision.
export const DANGEROUS_RPC_DECISIONS: Record<string, DangerousRpcDecision> = {
  "adminData.deleteView": {
    decision: "fresh-auth-required",
    reason: "Admin Data Explorer shared view deletion",
  },
  "adminData.saveView": {
    decision: "fresh-auth-required",
    reason: "Admin Data Explorer shared view mutation",
  },
  "adminData.runSql": {
    decision: "fresh-auth-required",
    reason: "Admin Data Explorer SQL execution against operational data",
  },
  "adminData.runView": {
    decision: "fresh-auth-required",
    reason: "Admin Data Explorer saved view execution against operational data",
  },
  "agent.run": {
    decision: "fresh-auth-not-required",
    reason: "agent run is not implemented; normal account auth is sufficient",
  },
  "db.deleteOldestAccountBlobs": {
    decision: "fresh-auth-not-required",
    reason: "caller-owned blob cleanup",
  },
  "db.deleteOldestProjectBlobs": {
    decision: "fresh-auth-not-required",
    reason: "collaborator-authorized project blob cleanup",
  },
  "db.removeBlobTtls": {
    decision: "fresh-auth-not-required",
    reason: "caller-owned blob retention update",
  },
  "db.saveBlob": {
    decision: "fresh-auth-not-required",
    reason: "quota-checked blob write",
  },
  "hosts.addHostSshAuthorizedKey": {
    decision: "fresh-auth-required",
    reason: "host SSH trust mutation",
  },
  "hosts.claimPendingCopies": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.createHost": {
    decision: "fresh-auth-required",
    reason: "host provisioning can create billable infrastructure",
  },
  "hosts.deleteHost": {
    decision: "fresh-auth-required",
    reason: "destructive host lifecycle action",
  },
  "hosts.deleteHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.deleteHostRootfsImage": {
    decision: "fresh-auth-required",
    reason: "host RootFS image deletion",
  },
  "hosts.deleteProjectBackupIndex": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.deleteProjectBackupIndexLocal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.drainHost": {
    decision: "fresh-auth-required",
    reason: "moves projects away from a host",
  },
  "hosts.drainHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.forceDeprovisionHost": {
    decision: "fresh-auth-required",
    reason: "destructive host deprovision path",
  },
  "hosts.forceDeprovisionHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.gcDeletedHostRootfsImages": {
    decision: "fresh-auth-required",
    reason: "host RootFS image garbage collection",
  },
  "hosts.issueProjectHostAgentAuthToken": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.issueProjectHostAuthToken": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.issueProjectHostAuthTokenLocal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.markProjectChanged": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.pullHostRootfsImage": {
    decision: "fresh-auth-required",
    reason: "host RootFS image import can consume storage",
  },
  "hosts.reconcileHostRehome": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.reconcileHostRuntimeDeployments": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.reconcileHostRuntimeDeploymentsInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.reconcileHostSoftware": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.reconcileHostSoftwareInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.recordAcpAdmissionDenial": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordAcpAdmissionDenialLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordCodexSiteUsage": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordManagedRootfsReleaseReplica": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordProjectBackup": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordProjectBackupIndex": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordProjectBackupIndexLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordProjectBackupLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordServiceAdmissionDenial": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordServiceAdmissionDenialLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordServiceAdmissionNearLimit": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.recordServiceAdmissionNearLimitLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordBrowserAutomationAudit": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordLaunchSmokeResult": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordUxLatencyEvent": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.rehomeHost": {
    decision: "fresh-auth-required",
    reason: "host ownership/placement mutation",
  },
  "hosts.removeHostAccess": {
    decision: "fresh-auth-required",
    reason: "host access mutation",
  },
  "hosts.removeHostSshAuthorizedKey": {
    decision: "fresh-auth-required",
    reason: "host SSH trust mutation",
  },
  "hosts.removeSelfHostConnector": {
    decision: "fresh-auth-required",
    reason: "self-host connector removal",
  },
  "hosts.removeSelfHostConnectorInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.restartHost": {
    decision: "fresh-auth-required",
    reason: "host restart can disrupt all projects on a dedicated host",
  },
  "hosts.restartHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.restartHostProjects": {
    decision: "fresh-auth-required",
    reason: "bulk project restart on a host can disrupt many runtimes",
  },
  "hosts.rolloutHostManagedComponents": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.rolloutHostManagedComponentsInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.setHostAccess": {
    decision: "fresh-auth-required",
    reason: "host access mutation",
  },
  "hosts.setHostDeletionProtection": {
    decision: "fresh-auth-required",
    reason: "can disable host deletion protection",
  },
  "hosts.setHostOwnerSpendLimits": {
    decision: "fresh-auth-required",
    reason: "host spend cap mutation",
  },
  "hosts.setHostProjectRamLimit": {
    decision: "fresh-auth-required",
    reason: "host resource cap mutation",
  },
  "hosts.setHostPoolAccess": {
    decision: "fresh-auth-required",
    reason: "host public pool access mutation",
  },
  "hosts.setHostRuntimeDeployments": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.setHostStar": {
    decision: "fresh-auth-not-required",
    reason: "local account preference",
  },
  "hosts.startHost": {
    decision: "fresh-auth-required",
    reason: "host start can create billable infrastructure",
  },
  "hosts.startHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.stopHost": {
    decision: "fresh-auth-required",
    reason: "host stop can disrupt all projects on a dedicated host",
  },
  "hosts.stopHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.stopHostProjects": {
    decision: "fresh-auth-required",
    reason: "bulk project stop on a host can disrupt many runtimes",
  },
  "hosts.syncProjectBackupIndexes": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.syncProjectBackupIndexesLocal": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.updateCloudCatalog": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.updateCopyStatus": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "hosts.updateHostMachine": {
    decision: "fresh-auth-required",
    reason: "host machine configuration mutation",
  },
  "hosts.upgradeHostConnector": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.upgradeHostSoftware": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.upgradeHostSoftwareInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.upsertExternalCredential": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "aiSessions.upsertProjectHostSession": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "aiSessions.adminList": {
    decision: "fresh-auth-not-required",
    reason: "admin-only diagnostic Codex session visibility",
  },
  "aiSessions.adminInterrupt": {
    decision: "fresh-auth-required",
    reason: "admin interruption of a Codex session",
  },
  "aiSessions.adminInterruptAll": {
    decision: "fresh-auth-required",
    reason: "admin bulk interruption of Codex sessions",
  },
  "lro.cancel": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "lro.dismiss": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "messages.sendSystemNotice": {
    decision: "fresh-auth-not-required",
    reason: "admin-only notification send",
  },
  "notifications.archive": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "notifications.createAccountNotice": {
    decision: "fresh-auth-not-required",
    reason: "admin-only account notification creation",
  },
  "notifications.createCodexTurnNotice": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "notifications.createMention": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "notifications.markRead": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "notifications.save": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "org.addAdmin": {
    decision: "fresh-auth-required",
    reason: "organization administrator grant",
  },
  "org.addUser": {
    decision: "fresh-auth-required",
    reason: "organization membership mutation",
  },
  "org.create": {
    decision: "fresh-auth-required",
    reason: "organization creation",
  },
  "org.createUser": {
    decision: "fresh-auth-required",
    reason: "account creation into an organization",
  },
  "org.removeAdmin": {
    decision: "fresh-auth-required",
    reason: "organization administrator revoke",
  },
  "org.removeUser": {
    decision: "fresh-auth-required",
    reason: "organization membership mutation",
  },
  "org.set": {
    decision: "fresh-auth-required",
    reason: "organization metadata mutation",
  },
  "projects.archiveProject": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.assignProjectHost": {
    decision: "fresh-auth-not-required",
    reason: "initial host assignment for an unassigned project",
  },
  "projects.beginRestoreStaging": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.cancelPendingCopy": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.cancelProjectRootfsBuild": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized cancellation of an in-project durable RootFS build",
  },
  "projects.cleanupRestoreStaging": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.createBackup": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.createCollabInvite": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.createSnapshot": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.deleteBackup": {
    decision: "fresh-auth-required",
    reason: "project backup deletion",
  },
  "projects.deleteProjectSecret": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.deleteProjectSshKey": {
    decision: "fresh-auth-required",
    reason: "project SSH trust revocation",
  },
  "projects.deleteSnapshot": {
    decision: "fresh-auth-required",
    reason: "project snapshot deletion",
  },
  "projects.pruneSnapshotPath": {
    decision: "fresh-auth-required",
    reason: "project snapshot path deletion",
  },
  "projects.drainProjectRehome": {
    decision: "fresh-auth-required",
    reason: "project ownership migration maintenance",
  },
  "projects.finalizeRestoreStaging": {
    decision: "fresh-auth-required",
    reason: "finalizes staged project restore",
  },
  "projects.generateProjectSshKeySecret": {
    decision: "fresh-auth-required",
    reason: "project SSH trust and private-key secret mutation",
  },
  "projects.hardDeleteProject": {
    decision: "fresh-auth-required",
    reason: "irreversible project deletion",
  },
  "projects.leaveOrDeleteProjects": {
    decision: "fresh-auth-required",
    reason: "bulk project leave/delete",
  },
  "projects.moveProject": {
    decision: "fresh-auth-required",
    reason: "project move/rehome mutation",
  },
  "projects.reconcileProjectRehome": {
    decision: "fresh-auth-required",
    reason: "project ownership migration maintenance",
  },
  "projects.rehomeProject": {
    decision: "fresh-auth-required",
    reason: "project ownership migration mutation",
  },
  "projects.releaseRestoreStaging": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.removeCollaborator": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.sendCourseAssignmentPatch": {
    decision: "fresh-auth-not-required",
    reason:
      "course collaborator-authorized selected assignment file distribution",
  },
  "projects.repairAcceptedCourseStudentInviteAccounts": {
    decision: "fresh-auth-not-required",
    reason:
      "course collaborator-authorized invite/account reconciliation for accepted student invites",
  },
  "projects.requestProjectAccess": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.restart": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.restoreBackup": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized restore of backup files into a project; same impact class as normal project file writes",
  },
  "projects.restoreSnapshot": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized snapshot/rootfs restore; recoverable project state mutation with same impact class as normal project file writes",
  },
  "projects.repairAcceptedCourseStudentInviteAccounts": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized course invite/account repair for existing accepted students",
  },
  "projects.setProjectEnv": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setProjectManageUsersOwnerOnly": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setProjectRootfsPublishConfig": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized RootFS publish metadata defaults for the project",
  },
  "projects.setProjectLabels": {
    decision: "fresh-auth-not-required",
    reason: "collaborator-authorized project metadata labels",
  },
  "projects.recordProjectRootfsBuildPublish": {
    decision: "fresh-auth-not-required",
    reason:
      "records an existing RootFS publish LRO on a collaborator-authorized build; publish creation enforces fresh auth separately",
  },
  "projects.setLocalProjectManageUsersOwnerOnly": {
    decision: "internal-auth-only",
    reason: "owning-bay internal project policy mutation",
  },
  "projects.setProjectHidden": {
    decision: "fresh-auth-not-required",
    reason: "local account preference",
  },
  "projects.setLocalProjectsHidden": {
    decision: "fresh-auth-not-required",
    reason: "local account preference",
  },
  "projects.setLocalProjectDeletionProtection": {
    decision: "fresh-auth-required",
    reason: "owning-bay project deletion protection mutation",
  },
  "projects.setProjectSecret": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setProjectDeletionProtection": {
    decision: "fresh-auth-required",
    reason: "can disable project deletion protection",
  },
  "projects.setProjectsHidden": {
    decision: "fresh-auth-not-required",
    reason: "local account preference",
  },
  "projects.setProjectSshKey": {
    decision: "fresh-auth-required",
    reason: "project SSH trust mutation",
  },
  "projects.setProjectUserRole": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.start": {
    decision: "fresh-auth-not-required",
    reason:
      "ordinary endpoint authorization is intended; admin/internal-only managed egress overrides are gated in the implementation",
  },
  "projects.startProjectRootfsBuild": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized in-project durable RootFS build; publishing remains separately gated",
  },
  "projects.startFromHost": {
    decision: "fresh-auth-not-required",
    reason: "host-assigned project start path; host assignment is checked",
  },
  "projects.stop": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.updateAuthorizedKeysOnHost": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "purchases.adminProvisionSiteLicense": {
    decision: "fresh-auth-required",
    reason: "admin site-license entitlement mutation",
  },
  "purchases.adminResetMembershipUsageWindows": {
    decision: "fresh-auth-required",
    reason: "admin operation resets user-visible membership usage windows",
  },
  "purchases.addSiteLicensePool": {
    decision: "fresh-auth-required",
    reason: "site-license commercial terms and domain entitlement mutation",
  },
  "purchases.addSiteLicenseExternalClaimKey": {
    decision: "fresh-auth-required",
    reason: "site-license external token verification authority mutation",
  },
  "purchases.archiveSiteLicensePool": {
    decision: "fresh-auth-required",
    reason: "site-license commercial terms and domain entitlement mutation",
  },
  "purchases.assignMembershipPackageSeat": {
    decision: "fresh-auth-required",
    reason: "paid membership seat assignment",
  },
  "purchases.assignSiteLicensePoolSeat": {
    decision: "fresh-auth-required",
    reason: "site-license pool seat assignment",
  },
  "purchases.cancelSiteLicensePoolRequest": {
    decision: "fresh-auth-not-required",
    reason: "user cancels their own pending site-license pool request",
  },
  "purchases.claimMembershipPackageSeat": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "purchases.createAbuseReviewAnnotation": {
    decision: "fresh-auth-required",
    reason:
      "admin abuse-review annotation can mark accounts/projects as abusive or urgent",
  },
  "purchases.createSiteLicenseExternalClaimPool": {
    decision: "fresh-auth-required",
    reason: "site-license external token claim authority mutation",
  },
  "purchases.disableSiteLicenseExternalClaimPool": {
    decision: "fresh-auth-required",
    reason: "site-license external token claim authority mutation",
  },
  "purchases.purchaseMembershipPackage": {
    decision: "fresh-auth-required",
    reason: "browser purchase action",
  },
  "purchases.purchaseMembershipPackages": {
    decision: "fresh-auth-required",
    reason: "browser purchase action",
  },
  "purchases.purchaseTeamLicenseChange": {
    decision: "fresh-auth-required",
    reason: "browser purchase action",
  },
  "purchases.requestSiteLicensePool": {
    decision: "fresh-auth-not-required",
    reason:
      "user request is gated by verified email/domain and manager approval policy",
  },
  "purchases.releaseSiteLicensePoolSeat": {
    decision: "fresh-auth-not-required",
    reason: "user releases their own claimed site-license pool seat",
  },
  "purchases.removeSiteLicenseManager": {
    decision: "fresh-auth-required",
    reason: "site-license manager authority mutation",
  },
  "purchases.revokeAbuseReviewAnnotation": {
    decision: "fresh-auth-required",
    reason:
      "admin abuse-review annotation revocation changes abuse triage state",
  },
  "purchases.revokeMembershipPackageSeat": {
    decision: "fresh-auth-required",
    reason: "paid membership seat revocation",
  },
  "purchases.revokeSiteLicenseExternalClaimKey": {
    decision: "fresh-auth-required",
    reason: "site-license external token verification authority mutation",
  },
  "purchases.setSiteLicenseManager": {
    decision: "fresh-auth-required",
    reason: "site-license manager authority mutation",
  },
  "purchases.reviewSiteLicensePoolRequest": {
    decision: "fresh-auth-required",
    reason: "site-license pool approval can grant paid membership seats",
  },
  "purchases.updateMembershipPackage": {
    decision: "fresh-auth-required",
    reason:
      "site-license pool edits change commercial/domain entitlements; ordinary non-site package edits remain ordinary authz",
  },
  "purchases.updateSiteLicense": {
    decision: "fresh-auth-required",
    reason: "site-license commercial terms and domain entitlement mutation",
  },
  "software.createLicense": {
    decision: "fresh-auth-required",
    reason:
      "admin software license minting changes signed commercial entitlements",
  },
  "software.createLicenseOnSeed": {
    decision: "internal-auth-only",
    reason:
      "seed-local helper is only reached from fresh-auth-checked public software RPCs or trusted inter-bay service handlers",
  },
  "software.restoreLicense": {
    decision: "fresh-auth-required",
    reason:
      "admin software license restoration changes signed commercial entitlements",
  },
  "software.restoreLicenseOnSeed": {
    decision: "internal-auth-only",
    reason:
      "seed-local helper is only reached from fresh-auth-checked public software RPCs or trusted inter-bay service handlers",
  },
  "software.revokeLicense": {
    decision: "fresh-auth-required",
    reason:
      "admin software license revocation changes signed commercial entitlements",
  },
  "software.revokeLicenseOnSeed": {
    decision: "internal-auth-only",
    reason:
      "seed-local helper is only reached from fresh-auth-checked public software RPCs or trusted inter-bay service handlers",
  },
  "software.upsertLicenseTier": {
    decision: "fresh-auth-required",
    reason:
      "admin software license tier edits change signed commercial entitlement templates",
  },
  "software.upsertLicenseTierOnSeed": {
    decision: "internal-auth-only",
    reason:
      "seed-local helper is only reached from fresh-auth-checked public software RPCs or trusted inter-bay service handlers",
  },
  "sync.purgeHistory": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.adminCreateUser": {
    decision: "fresh-auth-required",
    reason: "admin account creation with password issuance",
  },
  "system.adminResetPasswordLink": {
    decision: "fresh-auth-required",
    reason: "admin password reset link generation for another user",
  },
  "system.adminVerifyEmailAddress": {
    decision: "fresh-auth-required",
    reason: "admin email verification for another user",
  },
  "system.adminDisableTwoFactor": {
    decision: "fresh-auth-required",
    reason: "admin removal of two-factor authentication for another user",
  },
  "system.adminGrantAdminRole": {
    decision: "fresh-auth-required",
    reason: "admin grants site-admin privileges to another account",
  },
  "system.adminRevokeAdminRole": {
    decision: "fresh-auth-required",
    reason: "admin removes site-admin privileges from an account",
  },
  "system.adminSalesloftSync": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.applyCloudflareTunnelSettings": {
    decision: "fresh-auth-required",
    reason: "admin applies stored Cloudflare tunnel credentials to runtime",
  },
  "system.bootstrapCloudflareConfiguration": {
    decision: "fresh-auth-required",
    reason: "Cloudflare tunnel/R2 configuration bootstrap with cloud token",
  },
  "system.clearAccountEntitlementOverride": {
    decision: "fresh-auth-required",
    reason: "admin entitlement mutation",
  },
  "system.clearAdminAssignedMembership": {
    decision: "fresh-auth-required",
    reason: "admin membership mutation",
  },
  "system.clearParallelOpsLimit": {
    decision: "fresh-auth-required",
    reason: "admin worker concurrency limit mutation",
  },
  "system.clearProviderSetupChallenge": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.createCloudflareTeardownPlan": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.createImpersonationGrant": {
    decision: "fresh-auth-required",
    reason: "admin impersonation grant",
  },
  "system.createProviderSetupChallenge": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.deleteAccount": {
    decision: "fresh-auth-required",
    reason: "account deletion",
  },
  "system.deleteOpenAiApiKey": {
    decision: "fresh-auth-required",
    reason: "OpenAI external credential revocation",
  },
  "system.deletePassport": {
    decision: "fresh-auth-required",
    reason: "account SSO/passport login method unlink",
  },
  "system.drainAccountCollaboratorIndexProjection": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.drainAccountNotificationIndexProjection": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.drainAccountProjectIndexProjection": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.drainAccountRehome": {
    decision: "fresh-auth-required",
    reason: "account ownership migration maintenance",
  },
  "system.issueBrowserSignInCookie": {
    decision: "fresh-auth-required",
    reason:
      "returns a raw remember-me cookie to the caller for browser session handoff",
  },
  "system.publishProjectRootfsImage": {
    decision: "fresh-auth-required",
    reason: "RootFS catalog/release mutation",
  },
  "system.reconcileAccountRehome": {
    decision: "fresh-auth-required",
    reason: "account ownership migration maintenance",
  },
  "system.recordManagedProjectEgress": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordManagedProjectCpuUsage": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordServiceAdmissionDenial": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.recordServiceAdmissionNearLimit": {
    decision: "fresh-auth-not-required",
    reason: TELEMETRY_ONLY,
  },
  "system.rehomeAccount": {
    decision: "fresh-auth-required",
    reason: "account ownership migration mutation",
  },
  "system.releaseProjectAppPublicSubdomain": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.removeBrowserSession": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.repairAccountMembershipPortability": {
    decision: "fresh-auth-required",
    reason: "account membership portability repair",
  },
  "system.requestRootfsImageDeletion": {
    decision: "fresh-auth-required",
    reason: "RootFS catalog deletion request",
  },
  "system.reserveProjectAppPublicSubdomain": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.revokeExternalCredential": {
    decision: "fresh-auth-required",
    reason: "external credential revocation",
  },
  "system.runBayBackup": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.runBayRestore": {
    decision: "fresh-auth-required",
    reason: "materialized bay database restore",
  },
  "system.runBayRestoreTest": {
    decision: "fresh-auth-required",
    reason: "materialized bay restore test workspace",
  },
  "system.runRootfsReleaseGc": {
    decision: "fresh-auth-required",
    reason: "RootFS catalog/release garbage collection",
  },
  "system.saveRootfsCatalogEntry": {
    decision: "fresh-auth-required",
    reason: "RootFS catalog/release mutation",
  },
  "system.scanRootfsRelease": {
    decision: "fresh-auth-required",
    reason: "admin RootFS vulnerability scan execution",
  },
  "system.scanProjectRootfs": {
    decision: "fresh-auth-not-required",
    reason: "collaborator-authorized live project RootFS preflight scan",
  },
  "system.setAccountEntitlementOverride": {
    decision: "fresh-auth-required",
    reason: "admin entitlement mutation",
  },
  "system.setAdminAssignedMembership": {
    decision: "fresh-auth-required",
    reason: "admin membership mutation",
  },
  "system.setBayProjectOwnershipAdmission": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.setOpenAiApiKey": {
    decision: "fresh-auth-required",
    reason: "OpenAI external credential mutation",
  },
  "system.setParallelOpsLimit": {
    decision: "fresh-auth-required",
    reason: "admin worker concurrency limit mutation",
  },
  "system.setProjectRootfsImage": {
    decision: "fresh-auth-not-required",
    reason:
      "collaborator-authorized normal project runtime environment selection",
  },
  "system.setSiteSettings": {
    decision: "fresh-auth-required",
    reason:
      "seed-authoritative global site settings mutation propagates across bays",
  },
  "system.setSiteSettingsOnSeed": {
    decision: "internal-auth-only",
    reason:
      "inter-bay seed implementation for site settings; public callers must use setSiteSettings with fresh auth",
  },
  "system.sendEmailVerification": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.sendTestEmail": {
    decision: "fresh-auth-not-required",
    reason: "admin-only email diagnostic",
  },
  "system.syncSiteSettingsToBays": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.syncSiteSettingsToBaysOnSeed": {
    decision: "internal-auth-only",
    reason:
      "seed-only mirror repair implementation; public callers must use syncSiteSettingsToBays",
  },
  "system.startCloudflareR2Audit": {
    decision: "fresh-auth-required",
    reason: "resource-consuming Cloudflare R2 bucket scan LRO",
  },
  "system.startCloudflareR2BayBackupCleanup": {
    decision: "fresh-auth-required",
    reason: "destructive Cloudflare R2 bay-backup object cleanup",
  },
  "system.startCloudflareTeardownApply": {
    decision: "fresh-auth-required",
    reason: "destructive Cloudflare teardown apply",
  },
  "system.upsertBrowserSession": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
};
