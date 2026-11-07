/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Which host uid a project container runs its user as.

keep-id (today): the project user (container uid 2001) is the host's runtime
user, via `--userns=keep-id`.

separate: the project user is PROJECT_RUNTIME_SEPARATE_UID, a uid from a
dedicated subordinate block of the runtime user. The container's files reach
it through idmapped views (root helper `project-view`), so files on disk keep
their owner. A host gets there in steps, and a project start uses separate
only when all of them are done; otherwise it starts as keep-id, as today, and
the reason is reported:

- mode-off / mode-invalid: COCALC_PROJECT_RUNTIME_UID_MODE isn't "separate";
- helper-old: the installed root helper doesn't report the project-view and
  overlay-idmap capabilities (`cocalc-runtime-storage project-view probe`).
  This is a capability probe, never a HELPER_SCHEMA_VERSION comparison: schema
  numbers are assigned in merge order and say nothing about features;
- map-missing-block: the live rootless map doesn't have the block yet (the
  subuid allocation reaches Podman only at the host's next reboot);
- map-unparsable / map-collision: the live map is not what we expect;
- host-unsafe: a safety precondition of the host failed (data root not
  hardened, /mnt/cocalc without nosuid,nodev, shared scratch exposed, ...).
  A capable helper alone is not enough.
*/

import {
  DEFAULT_PROJECT_RUNTIME_GID,
  DEFAULT_PROJECT_RUNTIME_UID,
  PROJECT_RUNTIME_SEPARATE_UID,
  PROJECT_RUNTIME_UID_BLOCK,
  PROJECT_RUNTIME_UID_MODES,
  type ProjectRuntimeUidMode,
} from "@cocalc/util/project-runtime";

export type RuntimeUidFallbackReason =
  | "mode-off"
  | "mode-invalid"
  | "helper-old"
  | "map-missing-block"
  | "map-unparsable"
  | "map-collision"
  | "host-unsafe";

export interface RuntimeUidModeStatus {
  configured: string;
  effective: ProjectRuntimeUidMode;
  reason?: RuntimeUidFallbackReason;
  detail?: string;
}

export interface MapExtent {
  inside: number;
  outside: number;
  length: number;
}

export type RuntimeIdentity =
  | { mode: "keep-id"; usernsArgs: string[]; status: RuntimeUidModeStatus }
  | {
      mode: "separate";
      // the host uid/gid the project user runs as
      uid: number;
      gid: number;
      usernsArgs: string[];
      status: RuntimeUidModeStatus;
    };

export function keepIdUsernsArgs(): string[] {
  return [
    `--userns=keep-id:uid=${DEFAULT_PROJECT_RUNTIME_UID},gid=${DEFAULT_PROJECT_RUNTIME_GID}`,
  ];
}

export function configuredRuntimeUidMode(
  env: NodeJS.ProcessEnv = process.env,
): {
  configured: string;
  mode?: ProjectRuntimeUidMode;
} {
  const configured = `${env.COCALC_PROJECT_RUNTIME_UID_MODE ?? ""}`.trim();
  if (!configured) return { configured: "keep-id", mode: "keep-id" };
  return (PROJECT_RUNTIME_UID_MODES as readonly string[]).includes(configured)
    ? { configured, mode: configured as ProjectRuntimeUidMode }
    : { configured };
}

// What separate mode needs from the root helper.
export const REQUIRED_HELPER_CAPABILITIES = ["project-view", "overlay-idmap"];

// "project-view:1 overlay-idmap:1" -> {"project-view": 1, "overlay-idmap": 1}
export function parseHelperCapabilities(text: unknown): Map<string, number> {
  const caps = new Map<string, number>();
  for (const token of `${text ?? ""}`.trim().split(/\s+/)) {
    const match = /^([a-z][a-z0-9-]*):(\d+)$/.exec(token);
    if (match) caps.set(match[1], Number(match[2]));
  }
  return caps;
}

export function parseIdMap(text: string): MapExtent[] | undefined {
  const extents: MapExtent[] = [];
  for (const line of `${text ?? ""}`.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 3 || !parts.every((x) => /^\d+$/.test(x))) {
      return undefined;
    }
    const [inside, outside, length] = parts.map(Number);
    extents.push({ inside, outside, length });
  }
  return extents.length > 0 ? extents : undefined;
}

// The container map today's keep-id produces (container id -> rootless inner
// id): 0..2000 -> 1..2001, 2002..65536 -> 2002..65536, 65537.. -> 65537..
// The separate map is the same with 2001 pointed at the block's inner id.
const CONTAINER_EXTENTS: MapExtent[] = [
  { inside: 0, outside: 1, length: 2001 },
  { inside: 2002, outside: 2002, length: 63535 },
  { inside: 65537, outside: 65537, length: 4128768 },
];

/**
 * The rootless inner id of the block's first host id, from the live map of
 * the rootless namespace (`podman unshare cat /proc/self/uid_map`).
 */
export function separateInnerId(
  extents: MapExtent[],
  hostId: number = PROJECT_RUNTIME_SEPARATE_UID,
): { inner?: number; reason?: RuntimeUidFallbackReason; detail?: string } {
  const block = extents.find(
    (e) =>
      e.outside === PROJECT_RUNTIME_UID_BLOCK.start &&
      e.length === PROJECT_RUNTIME_UID_BLOCK.length,
  );
  if (!block) return { reason: "map-missing-block" };
  const inner = block.inside + (hostId - block.outside);
  // composing the inner id through the live map must give back the host id
  const back = extents.find(
    (e) => inner >= e.inside && inner < e.inside + e.length,
  );
  if (!back || back.outside + (inner - back.inside) !== hostId) {
    return {
      reason: "map-collision",
      detail: `inner ${inner} doesn't map to ${hostId}`,
    };
  }
  // and it must not be one of the inner ids the container map already uses
  for (const e of CONTAINER_EXTENTS) {
    if (inner >= e.outside && inner < e.outside + e.length) {
      return {
        reason: "map-collision",
        detail: `inner ${inner} is inside a container range`,
      };
    }
  }
  return { inner };
}

export function separateUsernsArgs(
  innerUid: number,
  innerGid: number,
): string[] {
  const args: string[] = [];
  for (const [flag, inner, projectId] of [
    ["--uidmap", innerUid, DEFAULT_PROJECT_RUNTIME_UID],
    ["--gidmap", innerGid, DEFAULT_PROJECT_RUNTIME_GID],
  ] as const) {
    for (const e of CONTAINER_EXTENTS) {
      args.push(flag, `${e.inside}:${e.outside}:${e.length}`);
      if (e.inside === 0) {
        args.push(flag, `${projectId}:${inner}:1`);
      }
    }
  }
  return args;
}

export interface RuntimeIdentityInputs {
  env?: NodeJS.ProcessEnv;
  // stdout of `cocalc-runtime-storage project-view probe`; undefined when the
  // probe fails (an older helper exits 2)
  helperProbe: () => Promise<string | undefined>;
  // `podman unshare cat /proc/self/{uid,gid}_map`
  liveMaps: () => Promise<{ uidMap: string; gidMap: string }>;
  // the host's safety preconditions for separate mode; resolves to a list of
  // failures (empty when safe)
  hostPreconditions: () => Promise<string[]>;
}

export async function resolveRuntimeIdentity({
  env = process.env,
  helperProbe,
  liveMaps,
  hostPreconditions,
}: RuntimeIdentityInputs): Promise<RuntimeIdentity> {
  const keepId = (
    configured: string,
    reason: RuntimeUidFallbackReason,
    detail?: string,
  ): RuntimeIdentity => ({
    mode: "keep-id",
    usernsArgs: keepIdUsernsArgs(),
    status: {
      configured,
      effective: "keep-id",
      reason,
      ...(detail ? { detail } : {}),
    },
  });
  const { configured, mode } = configuredRuntimeUidMode(env);
  if (mode == null) return keepId(configured, "mode-invalid");
  if (mode !== "separate") return keepId(configured, "mode-off");
  let probe: string | undefined;
  try {
    probe = await helperProbe();
  } catch {
    probe = undefined;
  }
  const caps = parseHelperCapabilities(probe);
  const missing = REQUIRED_HELPER_CAPABILITIES.filter(
    (c) => !(caps.get(c)! >= 1),
  );
  if (missing.length > 0) {
    return keepId(
      configured,
      "helper-old",
      `helper lacks ${missing.join(", ")}`,
    );
  }
  let maps: { uidMap: string; gidMap: string };
  try {
    maps = await liveMaps();
  } catch (err) {
    return keepId(configured, "map-unparsable", `${err}`.slice(0, 200));
  }
  const uidExtents = parseIdMap(maps.uidMap);
  const gidExtents = parseIdMap(maps.gidMap);
  if (!uidExtents || !gidExtents) return keepId(configured, "map-unparsable");
  const uid = separateInnerId(uidExtents);
  const gid = separateInnerId(gidExtents);
  for (const r of [uid, gid]) {
    if (r.reason) return keepId(configured, r.reason, r.detail);
  }
  let failures: string[];
  try {
    failures = await hostPreconditions();
  } catch (err) {
    failures = [`precondition check failed: ${err}`.slice(0, 200)];
  }
  if (failures.length > 0) {
    return keepId(configured, "host-unsafe", failures.join("; ").slice(0, 500));
  }
  return {
    mode: "separate",
    uid: PROJECT_RUNTIME_SEPARATE_UID,
    gid: PROJECT_RUNTIME_SEPARATE_UID,
    usernsArgs: separateUsernsArgs(uid.inner!, gid.inner!),
    status: { configured, effective: "separate" },
  };
}
