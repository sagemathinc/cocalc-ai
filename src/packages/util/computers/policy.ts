/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A computer's policy: what its agents may do there. The policy approved at
// pairing is the ceiling P0, stored by the daemon and never widened by the
// hub. Later "effective" policies are accepted only if policyAtMost(effective,
// P0) holds, field by field. Plan: src/.agents/computers-plan-2026-10-11.md
// ("Policy and time", decisions 20-25).

import { isValidUUID } from "@cocalc/util/misc";

export const COMPUTER_POLICY_VERSION = 1;

/** Help sessions: 1 hour by default, extendable to at most 8 hours. */
export const DEFAULT_INITIAL_SECONDS = 60 * 60;
export const MAX_SESSION_SECONDS = 8 * 60 * 60;

export const MAX_MOUNTS = 32;
export const MAX_IMAGE_REFS = 64;
const MAX_PATH_LENGTH = 4096;
const MAX_IMAGE_REF_LENGTH = 255;

export type ComputerMode = "direct" | "isolated";
export type MountAccess = "ro" | "rw";

/**
 * A host directory mounted into isolated containers. It is resolved on the
 * machine before approval: an absolute canonical path plus the identity of
 * what it resolved to, so a later swap (a symlink, a replaced directory) is
 * refused at use. device and inode are decimal strings (they can exceed 2^53).
 */
export interface ComputerMount {
  path: string;
  access: MountAccess;
  device: string;
  inode: string;
}

export type ImageRule = { kind: "any" } | { kind: "allow"; refs: string[] };

export interface ResourceLimits {
  /** CPU in thousandths of a core; null means no limit. */
  cpu_millis: number | null;
  memory_bytes: number | null;
  pids: number | null;
}

export interface ComputerPolicy {
  version: 1;
  /**
   * direct: commands run on the host as the user who connected the computer;
   * that is full trust, and every other field is at its widest.
   * isolated: rootless podman containers; the fields below are enforced.
   */
  mode: ComputerMode;
  /** null: no time limit. */
  duration: null | { initial_seconds: number; max_seconds: number };
  /** The computer serves exactly this agent network's members (decision 22). */
  agent_network_id: string;
  network: "on" | "off";
  gpu: boolean;
  /** Sorted by path; at most one entry per path. */
  mounts: ComputerMount[];
  images: ImageRule;
  /** Soft quota for scratch space; null means none. */
  scratch_bytes: number | null;
  limits: ResourceLimits;
}

export class PolicyError extends Error {}

const TOP_LEVEL_KEYS = [
  "version",
  "mode",
  "duration",
  "agent_network_id",
  "network",
  "gpu",
  "mounts",
  "images",
  "scratch_bytes",
  "limits",
] as const;

/**
 * Parse and normalize a policy. Strict: unknown fields, unknown versions and
 * out-of-range values are errors, so a newer or tampered policy fails closed.
 */
export function parseComputerPolicy(input: unknown): ComputerPolicy {
  const obj = record(input, "policy");
  onlyKeys(obj, TOP_LEVEL_KEYS, "policy");
  if (obj.version !== COMPUTER_POLICY_VERSION) {
    throw new PolicyError(`unsupported policy version ${obj.version}`);
  }
  const mode = oneOf(obj.mode, ["direct", "isolated"] as const, "mode");
  const duration = parseDuration(obj.duration);
  if (
    typeof obj.agent_network_id !== "string" ||
    !isValidUUID(obj.agent_network_id)
  ) {
    throw new PolicyError("agent_network_id must be a UUID");
  }
  const network = oneOf(obj.network, ["on", "off"] as const, "network");
  if (typeof obj.gpu !== "boolean")
    throw new PolicyError("gpu must be a boolean");
  const mounts = parseMounts(obj.mounts);
  const images = parseImages(obj.images);
  const scratch_bytes = optionalCount(obj.scratch_bytes, "scratch_bytes");
  const limits = parseLimits(obj.limits);
  const policy: ComputerPolicy = {
    version: 1,
    mode,
    duration,
    agent_network_id: obj.agent_network_id.toLowerCase(),
    network,
    gpu: obj.gpu,
    mounts,
    images,
    scratch_bytes,
    limits,
  };
  if (mode === "direct" && !isWidest(policy)) {
    // Direct mode can't enforce containers, mounts, networks or limits, so a
    // policy must not pretend otherwise (the review's "read-only mount on a
    // direct computer" contradiction).
    throw new PolicyError(
      "a direct policy has no mounts, image rules, scratch quota or limits; network and gpu are as the host allows",
    );
  }
  return policy;
}

function isWidest(policy: ComputerPolicy): boolean {
  return (
    policy.network === "on" &&
    policy.gpu === true &&
    policy.mounts.length === 0 &&
    policy.images.kind === "any" &&
    policy.scratch_bytes == null &&
    policy.limits.cpu_millis == null &&
    policy.limits.memory_bytes == null &&
    policy.limits.pids == null
  );
}

/** The fields a direct policy must have (everything at its widest). */
export function directPolicyDefaults(): Pick<
  ComputerPolicy,
  "network" | "gpu" | "mounts" | "images" | "scratch_bytes" | "limits"
> {
  return {
    network: "on",
    gpu: true,
    mounts: [],
    images: { kind: "any" },
    scratch_bytes: null,
    limits: { cpu_millis: null, memory_bytes: null, pids: null },
  };
}

function parseDuration(value: unknown): ComputerPolicy["duration"] {
  if (value === null) return null;
  const obj = record(value, "duration");
  onlyKeys(obj, ["initial_seconds", "max_seconds"], "duration");
  const initial = count(obj.initial_seconds, "duration.initial_seconds");
  const max = count(obj.max_seconds, "duration.max_seconds");
  if (initial < 60) throw new PolicyError("a session lasts at least a minute");
  if (initial > max) {
    throw new PolicyError("initial_seconds can't exceed max_seconds");
  }
  if (max > MAX_SESSION_SECONDS) {
    throw new PolicyError(
      `a time limit can't exceed ${MAX_SESSION_SECONDS / 3600} hours`,
    );
  }
  return { initial_seconds: initial, max_seconds: max };
}

function parseMounts(value: unknown): ComputerMount[] {
  if (!Array.isArray(value)) throw new PolicyError("mounts must be an array");
  if (value.length > MAX_MOUNTS) {
    throw new PolicyError(`at most ${MAX_MOUNTS} mounts`);
  }
  const mounts = value.map((item, i) => {
    const obj = record(item, `mounts[${i}]`);
    onlyKeys(obj, ["path", "access", "device", "inode"], `mounts[${i}]`);
    return {
      path: canonicalAbsolutePath(obj.path, `mounts[${i}].path`),
      access: oneOf(obj.access, ["ro", "rw"] as const, `mounts[${i}].access`),
      device: decimalString(obj.device, `mounts[${i}].device`),
      inode: decimalString(obj.inode, `mounts[${i}].inode`),
    };
  });
  mounts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < mounts.length; i++) {
    if (mounts[i].path === mounts[i - 1].path) {
      throw new PolicyError(`mount ${mounts[i].path} is listed twice`);
    }
  }
  return mounts;
}

/**
 * Accept only absolute, already-normalized paths: no ".", "..", empty
 * segments or trailing slash, and never "/" itself. Resolution (symlinks,
 * ~) happens on the machine before approval; this only refuses anything that
 * isn't the result of that resolution.
 */
export function canonicalAbsolutePath(value: unknown, where = "path"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyError(`${where} must be a non-empty string`);
  }
  if (value.length > MAX_PATH_LENGTH || value.includes("\u0000")) {
    throw new PolicyError(`${where} is not a valid path`);
  }
  if (!value.startsWith("/") || value === "/" || value.endsWith("/")) {
    throw new PolicyError(`${where} must be an absolute path other than /`);
  }
  for (const segment of value.slice(1).split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new PolicyError(`${where} must be a canonical path`);
    }
  }
  return value;
}

function parseImages(value: unknown): ImageRule {
  const obj = record(value, "images");
  if (obj.kind === "any") {
    onlyKeys(obj, ["kind"], "images");
    return { kind: "any" };
  }
  if (obj.kind !== "allow")
    throw new PolicyError("images.kind must be any or allow");
  onlyKeys(obj, ["kind", "refs"], "images");
  if (!Array.isArray(obj.refs))
    throw new PolicyError("images.refs must be an array");
  if (obj.refs.length > MAX_IMAGE_REFS) {
    throw new PolicyError(`at most ${MAX_IMAGE_REFS} image references`);
  }
  const refs = Array.from(
    new Set(obj.refs.map((ref, i) => imageRef(ref, `images.refs[${i}]`))),
  ).sort();
  return { kind: "allow", refs };
}

// A conservative image reference: registry/path[:tag][@sha256:digest].
const IMAGE_REF =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export function imageRef(value: unknown, where = "image"): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_IMAGE_REF_LENGTH ||
    !IMAGE_REF.test(value)
  ) {
    throw new PolicyError(`${where} is not a valid image reference`);
  }
  return value;
}

function parseLimits(value: unknown): ResourceLimits {
  const obj = record(value, "limits");
  onlyKeys(obj, ["cpu_millis", "memory_bytes", "pids"], "limits");
  return {
    cpu_millis: optionalCount(obj.cpu_millis, "limits.cpu_millis"),
    memory_bytes: optionalCount(obj.memory_bytes, "limits.memory_bytes"),
    pids: optionalCount(obj.pids, "limits.pids"),
  };
}

/**
 * Is `candidate` at most `ceiling`, field by field? Returns the reasons it is
 * not; an empty list means it is. The daemon computes this itself: the hub
 * can't simply label a policy "narrower".
 */
export function policyWideningReasons(
  candidate: ComputerPolicy,
  ceiling: ComputerPolicy,
): string[] {
  const reasons: string[] = [];
  if (candidate.version !== ceiling.version) reasons.push("version differs");
  if (candidate.mode === "direct" && ceiling.mode === "isolated") {
    reasons.push("direct mode exceeds an isolated ceiling");
  }
  if (!durationAtMost(candidate.duration, ceiling.duration)) {
    reasons.push("time limit exceeds the ceiling");
  }
  if (candidate.agent_network_id !== ceiling.agent_network_id) {
    reasons.push("a different agent network");
  }
  if (candidate.network === "on" && ceiling.network === "off") {
    reasons.push("network access exceeds the ceiling");
  }
  if (candidate.gpu && !ceiling.gpu)
    reasons.push("GPU access exceeds the ceiling");
  // A direct ceiling already allows everything that user can reach, so any
  // mount is within it; under an isolated ceiling only approved mounts are.
  for (const mount of ceiling.mode === "direct" ? [] : candidate.mounts) {
    const allowed = ceiling.mounts.find((m) => m.path === mount.path);
    if (
      allowed == null ||
      allowed.device !== mount.device ||
      allowed.inode !== mount.inode
    ) {
      reasons.push(`mount ${mount.path} is not in the ceiling`);
    } else if (mount.access === "rw" && allowed.access === "ro") {
      reasons.push(`mount ${mount.path} is read-only in the ceiling`);
    }
  }
  if (!imagesAtMost(candidate.images, ceiling.images)) {
    reasons.push("image rules exceed the ceiling");
  }
  if (!countAtMost(candidate.scratch_bytes, ceiling.scratch_bytes)) {
    reasons.push("scratch quota exceeds the ceiling");
  }
  for (const key of ["cpu_millis", "memory_bytes", "pids"] as const) {
    if (!countAtMost(candidate.limits[key], ceiling.limits[key])) {
      reasons.push(`${key} exceeds the ceiling`);
    }
  }
  return reasons;
}

export function policyAtMost(
  candidate: ComputerPolicy,
  ceiling: ComputerPolicy,
): boolean {
  return policyWideningReasons(candidate, ceiling).length === 0;
}

function durationAtMost(
  a: ComputerPolicy["duration"],
  b: ComputerPolicy["duration"],
): boolean {
  if (b == null) return true; // no limit is the widest
  if (a == null) return false;
  return (
    a.initial_seconds <= b.initial_seconds && a.max_seconds <= b.max_seconds
  );
}

function imagesAtMost(a: ImageRule, b: ImageRule): boolean {
  if (b.kind === "any") return true;
  if (a.kind === "any") return false;
  const allowed = new Set(b.refs);
  return a.refs.every((ref) => allowed.has(ref));
}

/** null means "no limit", the widest value. */
function countAtMost(a: number | null, b: number | null): boolean {
  if (b == null) return true;
  if (a == null) return false;
  return a <= b;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new PolicyError(`${where}: unknown field '${key}'`);
    }
  }
  for (const key of allowed) {
    if (!(key in obj)) throw new PolicyError(`${where}: missing '${key}'`);
  }
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new PolicyError(`${where} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PolicyError(`${where} must be a non-negative integer`);
  }
  return value;
}

function optionalCount(value: unknown, where: string): number | null {
  if (value === null) return null;
  const n = count(value, where);
  if (n === 0) throw new PolicyError(`${where} must be positive or null`);
  return n;
}

function decimalString(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,24})$/.test(value)) {
    throw new PolicyError(`${where} must be a decimal string`);
  }
  return value;
}
