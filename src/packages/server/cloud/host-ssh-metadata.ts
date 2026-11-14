/*
The fields of a host's machine metadata that the bay later uses to run ssh:
ssh_user and public_ip (the destination of the bootstrap reconcile, and what
providers copy into the host's runtime) and self_host_ssh_target. They come
from the request that creates or updates a host, so they are checked where they
are written, and again where they are used (see @cocalc/backend/ssh-destination).
*/

import {
  formatSshTargetSpec,
  parseSshTargetSpec,
  safeSshHost,
  safeSshLoginName,
} from "@cocalc/backend/ssh-destination";

/** Throws if machine metadata carries an ssh field that is not allowed. */
export function assertHostSshMetadataAllowed(metadata: unknown): void {
  if (metadata == null || typeof metadata !== "object") return;
  const m = metadata as Record<string, unknown>;
  if (m.ssh_user != null && safeSshLoginName(m.ssh_user) == null) {
    throw new Error("machine ssh_user must be a plain login name");
  }
  if (
    m.public_ip != null &&
    safeSshHost(m.public_ip, { requireIp: true }) == null
  ) {
    throw new Error("machine public_ip must be an allowed IP address");
  }
  if (
    m.self_host_ssh_target != null &&
    parseSshTargetSpec(m.self_host_ssh_target) == null
  ) {
    throw new Error(
      "self_host_ssh_target must be [user@]host[:port] with a plain login name and an allowed host",
    );
  }
}

/** The ssh user to put in a host spec or bootstrap script: the stored value if
 * it is a plain login name, else an error (never a guess). */
export function hostSshUser(value: unknown, fallback = "ubuntu"): string {
  const user = value == null ? fallback : safeSshLoginName(value);
  if (user == null) {
    throw new Error("host ssh user is not a plain login name");
  }
  return user;
}

/** The canonical form of a self-host target, which is what gets stored. */
export function canonicalSelfHostSshTarget(value: unknown): string {
  const spec = parseSshTargetSpec(value);
  if (spec == null) {
    throw new Error(
      "self_host_ssh_target must be [user@]host[:port] with a plain login name and an allowed host",
    );
  }
  return formatSshTargetSpec(spec);
}

/** `machine` with its self_host_ssh_target, if any, in canonical form. */
export function withCanonicalSshTarget<T extends { metadata?: any }>(
  machine: T | undefined,
): T | undefined {
  const raw = machine?.metadata?.self_host_ssh_target;
  if (machine == null || raw == null) return machine;
  return {
    ...machine,
    metadata: {
      ...machine.metadata,
      self_host_ssh_target: canonicalSelfHostSshTarget(raw),
    },
  };
}
