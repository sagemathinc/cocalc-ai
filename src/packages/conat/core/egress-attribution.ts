/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Per-socket attribution of server egress bytes to (normalized) subjects, so
// that managed-egress accounting can say WHAT a browser received, not only
// how much.  Replies to requests are attributed to the request's subject
// ("reply:<subject>"), since the reply inbox itself says nothing useful.

// Distinct keys kept per socket; the rest are summed under OTHER_KEY.
export const MAX_EGRESS_SUBJECT_KEYS = 64;
export const OTHER_KEY = "(other)";
// Packets not sent for a routed message (handshake, pings, acks, info, ...).
export const CONTROL_KEY = "(control)";
const MAX_TOKENS = 6;

const UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isIdentifierToken(token: string): boolean {
  if (UUID_RE.test(token)) return true;
  if (/^\d+$/.test(token)) return true;
  // Generated client ids (e.g. persist clients) are upper-case base32-like,
  // possibly without any digit: "CEZFLEJZNX".
  if (token.length >= 8 && /^[A-Z0-9]+$/.test(token)) return true;
  // Random ids (inboxes, hashes, base64-ish keys) mix letters and digits.
  return token.length >= 12 && /\d/.test(token) && /[a-z]/i.test(token);
}

// Bounded-cardinality form of a subject: identifiers become "*", and long
// subjects are truncated.
export function normalizeSubjectForAttribution(subject: string): string {
  const tokens = `${subject ?? ""}`.split(".");
  const out = tokens
    .slice(0, MAX_TOKENS)
    .map((token) => (isIdentifierToken(token) ? "*" : token.slice(0, 40)));
  if (tokens.length > MAX_TOKENS) out.push(">");
  return out.join(".");
}

export function addEgressBytes(
  bySubject: Record<string, number>,
  key: string,
  bytes: number,
): void {
  if (!(bytes > 0)) return;
  if (
    bySubject[key] === undefined &&
    Object.keys(bySubject).length >= MAX_EGRESS_SUBJECT_KEYS
  ) {
    key = OTHER_KEY;
  }
  bySubject[key] = (bySubject[key] ?? 0) + bytes;
}

// Remembers which subject each pending reply inbox belongs to.  Bounded in
// entries, bytes and age: reply subjects longer than MAX_REPLY_SUBJECT_LENGTH
// are not remembered, only the request's (already bounded) normalized label
// is stored, and expired entries are pruned oldest-first on every insert.  A
// miss just means the reply is attributed to its inbox.
export const MAX_REPLY_SUBJECT_LENGTH = 256;

export class ReplySubjectAttribution {
  // insertion order is time order: remember() re-inserts
  private readonly labels = new Map<string, { label: string; at: number }>();

  constructor(
    private readonly maxEntries = 20_000,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  get size(): number {
    return this.labels.size;
  }

  private prune(now: number) {
    for (const [key, { at }] of this.labels) {
      if (now - at <= this.ttlMs && this.labels.size <= this.maxEntries) break;
      this.labels.delete(key);
    }
  }

  remember(replySubject: string, requestSubject: string, now = Date.now()) {
    if (!replySubject || replySubject.length > MAX_REPLY_SUBJECT_LENGTH) {
      return;
    }
    this.labels.delete(replySubject);
    this.labels.set(replySubject, {
      label: normalizeSubjectForAttribution(requestSubject),
      at: now,
    });
    this.prune(now);
  }

  lookup(replySubject: string, now = Date.now()): string | undefined {
    const entry = this.labels.get(replySubject);
    if (entry == null) return;
    if (now - entry.at > this.ttlMs) {
      this.labels.delete(replySubject);
      return;
    }
    return entry.label;
  }

  label(subject: string, now = Date.now()): string {
    const request = this.lookup(subject, now);
    return request == null
      ? normalizeSubjectForAttribution(subject)
      : `reply:${request}`;
  }
}

// Bytes per key added between two snapshots of a socket's counters.
export function diffEgressBySubject(
  current: Record<string, number> | undefined,
  previous: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const before = previous?.[key];
    const delta =
      Number.isFinite(before) && (before as number) <= value
        ? value - (before as number)
        : value;
    if (delta > 0) out[key] = delta;
  }
  return out;
}

// A rollup bucket accumulates every subject its samples report, up to this
// many (beyond it, the smallest are summed under OTHER_KEY, so totals are
// kept).  A minute of samples from one hub has at most 12 x 10 subjects.
export const MAX_ROLLUP_SUBJECT_KEYS = 256;
// Subjects shown per event when rollups are read.
export const MAX_REPORTED_TOP_SUBJECTS = 20;

function sumSubjectLists(lists: unknown[]): Record<string, number> {
  const bySubject: Record<string, number> = {};
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const subject = `${item?.subject ?? ""}`;
      const bytes = Number(item?.bytes);
      if (!subject || !(bytes > 0) || !Number.isFinite(bytes)) continue;
      bySubject[subject] = (bySubject[subject] ?? 0) + bytes;
    }
  }
  return bySubject;
}

// At most `limit` subjects, largest first; the rest are summed under
// OTHER_KEY.  The SQL rollup upsert applies the same rule.
export function foldEgressSubjects(
  bySubject: Record<string, number>,
  limit: number,
): { subject: string; bytes: number }[] {
  const sorted = topEgressSubjects(bySubject, Number.MAX_SAFE_INTEGER);
  if (sorted.length <= limit) return sorted;
  const kept: Record<string, number> = {};
  for (const { subject, bytes } of sorted.slice(0, limit - 1)) {
    kept[subject] = bytes;
  }
  const rest = sorted
    .slice(limit - 1)
    .reduce((total, { bytes }) => total + bytes, 0);
  kept[OTHER_KEY] = (kept[OTHER_KEY] ?? 0) + rest;
  return topEgressSubjects(kept, limit);
}

// Sum top-subject lists (samples of one rollup bucket) without losing
// totals: truncation to the reported top N happens only when reading.
export function mergeTopEgressSubjects(
  a: unknown,
  b: unknown,
  limit = MAX_ROLLUP_SUBJECT_KEYS,
): { subject: string; bytes: number }[] {
  return foldEgressSubjects(sumSubjectLists([a, b]), limit);
}

// What an event reports: the top subjects of its bucket, the rest summed
// under OTHER_KEY.
export function reportedTopEgressSubjects(
  list: unknown,
  limit = MAX_REPORTED_TOP_SUBJECTS,
): { subject: string; bytes: number }[] {
  return foldEgressSubjects(sumSubjectLists([list]), limit);
}

export function topEgressSubjects(
  bySubject: Record<string, number>,
  limit = 10,
): { subject: string; bytes: number }[] {
  return Object.entries(bySubject)
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([subject, bytes]) => ({ subject, bytes }));
}
