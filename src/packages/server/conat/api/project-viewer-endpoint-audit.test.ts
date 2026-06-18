/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readFileSync } from "node:fs";
import path from "node:path";

function readSource(relativePath: string): string {
  return readFileSync(path.join(__dirname, relativePath), "utf8");
}

function section(source: string, name: string): string {
  const markers = [
    `export async function ${name}(`,
    `async function ${name}(`,
    `export default async function ${name}(`,
  ];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (start == null) {
    throw new Error(`function ${name} not found`);
  }
  const candidates = [
    source.indexOf("\nexport async function ", start + 1),
    source.indexOf("\nasync function ", start + 1),
    source.indexOf("\nexport default async function ", start + 1),
  ].filter((index) => index >= 0);
  const end = candidates.length === 0 ? source.length : Math.min(...candidates);
  return source.slice(start, end);
}

function expectGuard(source: string, name: string, guards: string[]): void {
  const body = section(source, name);
  if (!guards.some((guard) => body.includes(guard))) {
    throw new Error(
      `${name} must keep one of these guards: ${guards.join(", ")}`,
    );
  }
}

describe("project viewer endpoint audit", () => {
  it("keeps hub project runtime, settings, secrets, SSH, and Codex paths behind non-viewer guards", () => {
    const projects = readSource("projects.ts");

    expectGuard(projects, "getProjectReadDetailsAllowRemote", [
      "getLocalProjectCollaboratorAccessStatus",
    ]);
    expect(section(projects, "getProjectReadDetailsAllowRemote")).toContain(
      "PROJECT_COLLABORATOR_REQUIRED_ERROR",
    );

    for (const name of [
      "setProjectEnv",
      "getProjectRuntimeSponsorStatus",
      "getRuntimeLog",
      "resolveWorkspaceSshConnection",
      "stop",
      "getProjectState",
      "getProjectAddress",
      "getProjectActiveOperation",
      "updateAuthorizedKeysOnHost",
      "setProjectSshKey",
      "deleteProjectSshKey",
      "moveProject",
      "assignProjectHost",
      "codexDeviceAuthStart",
      "codexDeviceAuthStatus",
      "codexDeviceAuthCancel",
      "codexUploadAuthFile",
      "getCodexUsageStatus",
      "chatStoreStats",
      "chatStoreRotate",
      "chatStoreListSegments",
      "chatStoreReadArchived",
      "chatStoreReadArchivedHit",
      "chatStoreSearch",
      "chatStoreDelete",
      "chatStoreVacuum",
    ]) {
      expectGuard(projects, name, [
        "assertCollab",
        "assertCollabAllowRemoteProjectAccess",
      ]);
    }

    expectGuard(projects, "runProjectStartLikeAction", [
      "assertCollabAllowRemoteProjectAccess",
    ]);
    expectGuard(projects, "exec", ["execProject"]);
    expectGuard(projects, "archiveProject", [
      "assertCanPerformDestructiveStorageAction",
    ]);
    expectGuard(projects, "hardDeleteProject", [
      "assertHardDeleteProjectPermission",
    ]);

    for (const name of [
      "listProjectSecrets",
      "setProjectSecret",
      "deleteProjectSecret",
      "copyProjectSecrets",
      "generateProjectSshKeySecret",
    ]) {
      expectGuard(projects, name, ["assertCollab"]);
    }
  });

  it("keeps snapshots and backups behind collaborator or destructive-storage guards", () => {
    const snapshots = readSource("project-snapshots.ts");
    for (const name of [
      "createSnapshot",
      "getSnapshotQuota",
      "allSnapshotUsage",
      "getSnapshotFileText",
      "restoreSnapshot",
    ]) {
      expectGuard(snapshots, name, ["assertCollab"]);
    }
    for (const name of ["deleteSnapshot", "pruneSnapshotPath"]) {
      expectGuard(snapshots, name, [
        "assertCanPerformDestructiveStorageAction",
      ]);
    }

    const backups = readSource("project-backups.ts");
    for (const name of [
      "createBackup",
      "getBackups",
      "getBackupFiles",
      "findBackupFiles",
      "getBackupFileText",
      "getBackupQuota",
    ]) {
      expectGuard(backups, name, ["assertCollab"]);
    }
    for (const name of [
      "deleteBackup",
      "restoreBackup",
      "beginRestoreStaging",
      "ensureRestoreStaging",
      "finalizeRestoreStaging",
      "releaseRestoreStaging",
      "cleanupRestoreStaging",
    ]) {
      expectGuard(backups, name, [
        "assertCanPerformDestructiveStorageAction",
        "assertCollab",
      ]);
    }
  });

  it("keeps inter-bay project details and project secrets handlers collaborator-only", () => {
    const projectControl = readSource("../../inter-bay/project-control.ts");
    expectGuard(projectControl, "assertLocalProjectReadAccessOrAdmin", [
      "assertLocalProjectCollaborator",
    ]);
    expectGuard(projectControl, "handleProjectDetailsGet", [
      "assertLocalProjectReadAccessOrAdmin",
    ]);

    const projectSecrets = readSource("../../inter-bay/project-secrets.ts");
    expectGuard(projectSecrets, "assertLocalProjectSecretAccess", [
      "assertLocalProjectCollaborator",
    ]);
    for (const name of [
      "handleProjectSecretsList",
      "handleProjectSecretsSet",
      "handleProjectSecretsDelete",
      "handleProjectSecretsCopy",
      "handleProjectSecretsExportForCopy",
      "handleProjectSecretsImportForCopy",
      "handleProjectSecretsGenerateSshKeySecret",
    ]) {
      expectGuard(projectSecrets, name, ["assertLocalProjectSecretAccess"]);
    }
  });

  it("keeps collaborator management local handlers collaborator/owner gated", () => {
    const collaborators = readSource("../../projects/collaborators.ts");
    for (const name of [
      "createCollabInvite",
      "setProjectUserRole",
      "inviteCollaborator",
      "inviteCollaboratorWithoutAccount",
    ]) {
      expectGuard(collaborators, name, ["assertLocalProjectCollaborator"]);
    }
    expectGuard(collaborators, "removeCollaborator", [
      "assertLocalProjectCollaborator",
      "getLocalProjectAccessStatus",
    ]);
  });

  it("keeps project execution itself behind collaborator access", () => {
    const exec = readSource("../../projects/exec.ts");
    expectGuard(exec, "exec", ["assertProjectCollaboratorAccessAllowRemote"]);
  });
});
