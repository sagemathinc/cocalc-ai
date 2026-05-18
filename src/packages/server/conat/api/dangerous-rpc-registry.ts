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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.restartHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.restartHostProjects": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
  "hosts.setHostOwnerSpendLimits": {
    decision: "fresh-auth-required",
    reason: "host spend cap mutation",
  },
  "hosts.setHostProjectRamLimit": {
    decision: "fresh-auth-required",
    reason: "host resource cap mutation",
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "hosts.stopHostInternal": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "hosts.stopHostProjects": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
  "lro.cancel": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "lro.dismiss": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "messages.send": {
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
  "projects.beginRestoreStaging": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.cancelPendingCopy": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.deleteSnapshot": {
    decision: "fresh-auth-required",
    reason: "project snapshot deletion",
  },
  "projects.drainProjectRehome": {
    decision: "fresh-auth-required",
    reason: "project ownership migration maintenance",
  },
  "projects.finalizeRestoreStaging": {
    decision: "fresh-auth-required",
    reason: "finalizes staged project restore",
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
  "projects.restart": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.restoreBackup": {
    decision: "fresh-auth-required",
    reason: "project backup restore",
  },
  "projects.restoreSnapshot": {
    decision: "fresh-auth-required",
    reason: "project snapshot restore",
  },
  "projects.setProjectEnv": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setProjectHidden": {
    decision: "fresh-auth-not-required",
    reason: "local account preference",
  },
  "projects.setProjectSecret": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setProjectSshKey": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.setQuotas": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.start": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.stop": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "projects.updateAuthorizedKeysOnHost": {
    decision: "internal-auth-only",
    reason: INTERNAL_AUTH_ONLY,
  },
  "purchases.adminProvisionMembershipPackage": {
    decision: "fresh-auth-required",
    reason: "admin membership entitlement mutation",
  },
  "purchases.assignMembershipPackageSeat": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "purchases.claimMembershipPackageSeat": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "purchases.purchaseMembershipPackage": {
    decision: "fresh-auth-required",
    reason: "browser purchase action",
  },
  "purchases.revokeMembershipPackageSeat": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "purchases.updateMembershipPackage": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "software.createLicense": {
    decision: "fresh-auth-not-required",
    reason: "admin-only software license mutation",
  },
  "software.restoreLicense": {
    decision: "fresh-auth-not-required",
    reason: "admin-only software license mutation",
  },
  "software.revokeLicense": {
    decision: "fresh-auth-not-required",
    reason: "admin-only software license mutation",
  },
  "software.upsertLicenseTier": {
    decision: "fresh-auth-not-required",
    reason: "admin-only software license tier mutation",
  },
  "sync.purgeHistory": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.adminCreateUser": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.adminResetPasswordLink": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.adminSalesloftSync": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.deletePassport": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
    decision: "fresh-auth-not-required",
    reason:
      "account-only auth transform overwrites account_id; used for browser session handoff",
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.runBayBackup": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.runBayRestore": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.runBayRestoreTest": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.setParallelOpsLimit": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.setProjectRootfsImage": {
    decision: "fresh-auth-required",
    reason: "RootFS catalog/project mutation",
  },
  "system.setSiteSettings": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
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
  "system.startCloudflareR2Audit": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.startCloudflareR2BayBackupCleanup": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.startCloudflareTeardownApply": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
  "system.terminate": {
    decision: "fresh-auth-not-required",
    reason: "admin-only development service control",
  },
  "system.upsertBrowserSession": {
    decision: "fresh-auth-not-required",
    reason: ORDINARY_AUTHZ,
  },
};
