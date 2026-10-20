/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Names for the per-project content origin (trust-free step 6):

  https://<project label>.<host label>.<content domain>

shared by the hub (DNS provisioning, minting URLs) and the project host
(routing), so they cannot drift apart.  The DNS record for a host is the
wildcard *.<host label>.<content domain>.
*/

function normalizeHostname(value: unknown): string {
  let host = `${value ?? ""}`.trim().toLowerCase();
  if (host.startsWith("[")) return host; // IPv6 literal: never a content host
  host = host.replace(/:\d*$/, "").replace(/\.+$/, "");
  return host;
}

// The content domain, e.g. "cocalcusercontent.com", or undefined if none is
// configured (then the content origin is off).  A scheme, port or path in the
// setting is ignored.
export function normalizeContentDomain(value: unknown): string | undefined {
  let raw = `${value ?? ""}`.trim().toLowerCase();
  raw = raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/, 1)[0];
  const domain = normalizeHostname(raw).replace(/^\.+/, "");
  if (!domain || !domain.includes(".")) return undefined;
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) return undefined;
  return domain;
}

export function projectContentLabel(project_id: string): string {
  return `${project_id}`.replace(/-/g, "").toLowerCase();
}

export function hostContentLabel(host_id: string): string {
  return `h-${`${host_id}`.replace(/-/g, "").toLowerCase()}`;
}

export function projectContentHostname({
  project_id,
  host_id,
  domain,
}: {
  project_id: string;
  host_id: string;
  domain: string;
}): string {
  return `${projectContentLabel(project_id)}.${hostContentLabel(host_id)}.${domain}`;
}

// The one DNS record a host needs for all of its projects' content origins.
export function hostContentWildcardHostname({
  host_id,
  domain,
}: {
  host_id: string;
  domain: string;
}): string {
  return `*.${hostContentLabel(host_id)}.${domain}`;
}
