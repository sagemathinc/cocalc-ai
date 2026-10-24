/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isProjectCollaboratorGroup } from "@cocalc/conat/auth/subject-policy";
import { ConatError } from "@cocalc/conat/util";
import type { HubApiRequestContext } from "@cocalc/lite/hub/api";
import { getRow } from "@cocalc/lite/hub/sqlite/database";
import { isValidUUID } from "@cocalc/util/misc";
import {
  getLocalExamAccountProjectId,
  isLocalExamProject,
} from "../exam/identity";

export const ACCOUNT_PROJECT_HOST_HUB_METHODS = new Set([
  "projects.codexDeviceAuthStart",
  "projects.codexDeviceAuthStartV2",
  "projects.getCodexCredentialSelectionCapability",
  "projects.codexDeviceAuthStatus",
  "projects.codexDeviceAuthCancel",
  "projects.claudeSubscriptionLoginStart",
  "projects.claudeSubscriptionLoginStatus",
  "projects.claudeSubscriptionLoginSubmitCode",
  "projects.claudeSubscriptionLoginCancel",
  "projects.codexUploadAuthFile",
  "projects.codexUploadAuthFileV2",
  "projects.getCodexUsageStatus",
  "projects.chatStoreStats",
  "projects.chatStoreRotate",
  "projects.chatStoreListSegments",
  "projects.chatStoreReadArchived",
  "projects.chatStoreReadArchivedHit",
  "projects.chatStoreSearch",
  "projects.chatStoreDelete",
  "projects.chatStoreVacuum",
  "notifications.createCodexAttentionNotice",
  "notifications.getCodexFreshAuthActionStatus",
]);

export const PROJECT_PROJECT_HOST_HUB_METHODS = new Set([
  "db.getBlob",
  "db.saveBlob",
  "compute.authorizeProjectSshKey",
  "compute.listProjectVms",
  "compute.getProjectVm",
  "compute.listProjectVolumes",
  "compute.getProjectVolume",
  "projects.getSshKeys",
  "system.getPublicSiteUrl",
  "system.getManagedProjectEgressPolicy",
  "system.recordManagedProjectEgress",
  "system.recordServiceAdmissionDenial",
  "system.recordServiceAdmissionNearLimit",
  "system.getServiceAdmissionConfig",
  "notifications.createCodexTurnNotice",
]);

export const EXAM_PROJECT_HOST_HUB_METHODS = new Set([
  "db.getBlob",
  "db.saveBlob",
  "projects.getSshKeys",
  "system.getPublicSiteUrl",
  "system.getManagedProjectEgressPolicy",
  "system.recordManagedProjectEgress",
  "system.recordServiceAdmissionDenial",
  "system.recordServiceAdmissionNearLimit",
  "system.getServiceAdmissionConfig",
]);

const MAX_REQUEST_PATH_LENGTH = 4096;

/**
 * A project may report only the file downloads its own proxy served. The
 * host forwards this to the bay with its own (host) scope, and the bay trusts
 * host-scoped reports for egress accounting and relay-abuse enforcement, so
 * a project must not be able to add another category, abuse evidence, or
 * other metadata. Rewrites args in place: these are the arguments the method
 * is then called with.
 */
function restrictProjectEgressReport(args: any[], subject: string): void {
  const opts = args?.[0];
  if (opts == null || typeof opts !== "object") {
    forbidden("invalid egress report", subject);
  }
  if (opts.category !== "file-download") {
    forbidden("projects may only report file-download egress", subject);
  }
  if (opts.bandwidth_relay_evidence != null) {
    forbidden("projects may not report bandwidth relay evidence", subject);
  }
  const metadata = opts.metadata;
  const safe: { request_path?: string; partial?: boolean } = {};
  if (metadata != null && typeof metadata === "object") {
    if (
      typeof metadata.request_path === "string" &&
      metadata.request_path.length <= MAX_REQUEST_PATH_LENGTH
    ) {
      safe.request_path = metadata.request_path;
    }
    if (typeof metadata.partial === "boolean") {
      safe.partial = metadata.partial;
    }
  }
  args[0] = {
    project_id: opts.project_id,
    category: "file-download",
    bytes: opts.bytes,
    metadata: safe,
  };
}

function forbidden(message: string, subject: string): never {
  throw new ConatError(message, { code: 403, subject });
}

function projectIdFromArgs(args: any[]): string | undefined {
  const project_id = args?.[0]?.project_id ?? args?.[0]?.source_project_id;
  return typeof project_id === "string" && isValidUUID(project_id)
    ? project_id
    : undefined;
}

function isProjectCollaboratorLocal({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): boolean {
  const row = getRow("projects", JSON.stringify({ project_id }));
  const userEntry = row?.users?.[account_id];
  const group = typeof userEntry === "string" ? userEntry : userEntry?.group;
  return isProjectCollaboratorGroup(group);
}

/**
 * Restrict the generic Lite hub API when it is embedded in project-host.
 * Trusted host-scoped callers retain the internal surface; account and project
 * identities get only the small set of methods needed by direct host routing.
 */
export function authorizeProjectHostHubApiRequest({
  subject,
  name,
  args,
  account_id,
  project_id,
  host_id,
}: HubApiRequestContext): void {
  if (host_id != null) {
    return;
  }

  if (account_id != null) {
    if (name === "system.ping") {
      return;
    }
    if (!ACCOUNT_PROJECT_HOST_HUB_METHODS.has(name)) {
      forbidden(
        "project-host hub API method is not available to account identities",
        subject,
      );
    }
    const targetProjectId = projectIdFromArgs(args);
    if (targetProjectId == null) {
      forbidden("not authorized for project", subject);
    }
    if (getLocalExamAccountProjectId(account_id) != null) {
      forbidden(
        "project-host hub API methods are disabled for exam accounts",
        subject,
      );
    }
    if (
      !isProjectCollaboratorLocal({
        account_id,
        project_id: targetProjectId,
      })
    ) {
      forbidden("not authorized for project", subject);
    }
    return;
  }

  if (project_id != null) {
    if (name === "system.ping") {
      return;
    }
    const allowedMethods = isLocalExamProject(project_id)
      ? EXAM_PROJECT_HOST_HUB_METHODS
      : PROJECT_PROJECT_HOST_HUB_METHODS;
    if (!allowedMethods.has(name)) {
      forbidden(
        "project-host hub API method is not available to project identities",
        subject,
      );
    }
    if (projectIdFromArgs(args) !== project_id) {
      forbidden(
        "project-host hub API request project does not match subject",
        subject,
      );
    }
    if (name === "system.recordManagedProjectEgress") {
      restrictProjectEgressReport(args, subject);
    }
    return;
  }

  forbidden("project-host hub API request has no authorized identity", subject);
}
