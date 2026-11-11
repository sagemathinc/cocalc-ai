/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { HostRuntimeDeploymentRecord } from "@cocalc/conat/hub/api/hosts";
import getLogger from "@cocalc/backend/logger";
import {
  listProjectHostRuntimeDeployments,
  loadEffectiveProjectHostRuntimeDeployments,
} from "@cocalc/database/postgres/project-host-runtime-deployments";
import isAdmin from "@cocalc/server/accounts/is-admin";

const logger = getLogger("server:conat:api:host-software-admin");

export const HOST_SOFTWARE_ADMIN_ONLY =
  "host software maintenance is limited to site admins";

// The hub API methods that change what software a host runs or boots. Only
// site admins may call them, whoever owns the host.
export const HOST_SOFTWARE_ADMIN_METHODS: ReadonlySet<string> = new Set([
  "hosts.pullHostRootfsImage",
  "hosts.deleteHostRootfsImage",
  "hosts.gcDeletedHostRootfsImages",
  "hosts.upgradeHostSoftware",
  "hosts.reconcileHostSoftware",
  "hosts.setHostRuntimeDeployments",
  "hosts.reconcileHostRuntimeDeployments",
  "hosts.rollbackHostRuntimeDeployments",
  "hosts.rolloutHostManagedComponents",
  "hosts.upgradeHostConnector",
]);

// Checked where a hub API call arrives, before it is routed to the bay that
// owns the host (which looks the host up, and may forward the call). The
// methods check again themselves.
export async function assertHostSoftwareAdminBeforeRouting({
  name,
  args,
  account_id,
}: {
  name: string;
  args?: any[];
  account_id?: string;
}): Promise<void> {
  const adminOnly =
    HOST_SOFTWARE_ADMIN_METHODS.has(name) ||
    (name === "hosts.listHostSoftwareVersions" && args?.[0]?.base_url != null);
  if (!adminOnly) return;
  if (!account_id || !(await isAdmin(account_id))) {
    throw new Error(HOST_SOFTWARE_ADMIN_ONLY);
  }
  assertSafeHostSoftwareSelection(args?.[0]);
}

export const UNSAFE_HOST_SOFTWARE_SELECTION =
  "invalid host software version or channel";

export const HOST_SOFTWARE_CHANNELS: ReadonlySet<string> = new Set([
  "latest",
  "staging",
]);

// A software version goes into a host's download URLs and install paths:
// letters and digits, then also ".", "_" and "-", never "..", and not a name
// the host uses for its own directories.
const SOFTWARE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_SOFTWARE_VERSIONS: ReadonlySet<string> = new Set([
  "current",
  "downloads",
]);

export function isSafeHostSoftwareVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SOFTWARE_VERSION.test(value) &&
    !value.includes("..") &&
    !RESERVED_SOFTWARE_VERSIONS.has(value)
  );
}

export function isSafeHostSoftwareChannel(value: unknown): value is string {
  return typeof value === "string" && HOST_SOFTWARE_CHANNELS.has(value);
}

// Whether a host software request (or a queued operation's input) names a
// version or channel that is not safe. A value that is absent names nothing.
export function unsafeHostSoftwareSelection(input: any): boolean {
  const versions: unknown[] = [input?.desired_version, input?.version];
  const channels: unknown[] = [];
  for (const target of Array.isArray(input?.targets) ? input.targets : []) {
    versions.push(target?.version);
    channels.push(target?.channel);
  }
  for (const deployment of Array.isArray(input?.deployments)
    ? input.deployments
    : []) {
    versions.push(deployment?.desired_version);
  }
  return (
    versions.some((v) => v != null && !isSafeHostSoftwareVersion(v)) ||
    channels.some((c) => c != null && !isSafeHostSoftwareChannel(c))
  );
}

// The last check before a version or channel is sent to a host, whatever
// its source: refuse, and log the host only (never the value).
export function assertSafeHostSoftwareSelectionForHost(
  input: any,
  host_id: string,
  what: string,
): void {
  if (unsafeHostSoftwareSelection(input)) {
    logger.warn("refused to send an unsafe software version to a host", {
      host_id,
      what,
    });
    throw new Error(UNSAFE_HOST_SOFTWARE_SELECTION);
  }
}

// A version from any source, or undefined (logged with the host only) when
// it is not safe.
export function safeHostSoftwareVersionOrUndefined(
  value: unknown,
  host_id: string,
  what: string,
): string | undefined {
  if (value == null || value === "") return undefined;
  if (isSafeHostSoftwareVersion(value)) return value;
  logger.warn("ignoring an unsafe software version", { host_id, what });
  return undefined;
}

export function assertSafeHostSoftwareSelection(input: any): void {
  if (unsafeHostSoftwareSelection(input)) {
    throw new Error(UNSAFE_HOST_SOFTWARE_SELECTION);
  }
}

// Which row, never its version (which may be anything).
function deploymentForLog(record: HostRuntimeDeploymentRecord) {
  return {
    scope_type: record.scope_type,
    host_id: record.host_id,
    target_type: record.target_type,
    target: record.target,
  };
}

function deploymentKey(record: HostRuntimeDeploymentRecord): string {
  return `${record.target_type}:${record.target}`;
}

// A host's effective runtime deployments -- what it should run -- from the
// rows an admin set: the global defaults, overridden by the host's own rows
// only where an admin set those. A host row set by anyone else (possible
// before host software became admin-only), or any row with an unsafe
// version, is ignored: the global default for that target applies instead.
export async function loadTrustedEffectiveRuntimeDeployments({
  host_id,
}: {
  host_id: string;
}): Promise<HostRuntimeDeploymentRecord[]> {
  const effective = await loadEffectiveProjectHostRuntimeDeployments({
    host_id,
  });
  const adminCache = new Map<string, boolean>();
  const setByAdmin = async (requested_by?: string): Promise<boolean> => {
    const account_id = `${requested_by ?? ""}`.trim();
    if (!account_id) return false;
    if (!adminCache.has(account_id)) {
      let admin = false;
      try {
        admin = await isAdmin(account_id);
      } catch {
        admin = false;
      }
      adminCache.set(account_id, admin);
    }
    return adminCache.get(account_id)!;
  };
  let globalByTarget: Map<string, HostRuntimeDeploymentRecord> | undefined;
  const trusted: HostRuntimeDeploymentRecord[] = [];
  for (const record of effective) {
    let chosen: HostRuntimeDeploymentRecord | undefined = record;
    if (record.scope_type !== "global") {
      if (!isSafeHostSoftwareVersion(record.desired_version)) {
        logger.warn(
          "ignoring a runtime deployment with an unsafe version",
          deploymentForLog(record),
        );
        chosen = undefined;
      } else if (!(await setByAdmin(record.requested_by))) {
        logger.warn(
          "ignoring a host runtime deployment not set by an admin",
          deploymentForLog(record),
        );
        chosen = undefined;
      }
      if (chosen == null) {
        globalByTarget ??= new Map(
          (
            await listProjectHostRuntimeDeployments({ scope_type: "global" })
          ).map((row) => [deploymentKey(row), row]),
        );
        chosen = globalByTarget.get(deploymentKey(record));
      }
    }
    if (chosen != null && !isSafeHostSoftwareVersion(chosen.desired_version)) {
      logger.warn(
        "ignoring a runtime deployment with an unsafe version",
        deploymentForLog(chosen),
      );
      chosen = undefined;
    }
    if (chosen != null) trusted.push(chosen);
  }
  return trusted;
}
