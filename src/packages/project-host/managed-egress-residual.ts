/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ManagedProjectEgressCategory } from "@cocalc/conat/hub/api/system";

export type ManagedBoundaryClassifiedCategory =
  | "http-proxy"
  | "ws-proxy"
  | "ssh";

export type ManagedBoundaryMetadata = {
  interface_name?: string;
  pid?: number;
};

export type ManagedRawNetworkResidualSample = {
  project_id: string;
  bytes: number;
  bucket_start: number;
  bucket_ms: number;
  boundary_bytes: number;
  classified_boundary_bytes: number;
  classified_categories: Partial<
    Record<ManagedBoundaryClassifiedCategory, number>
  >;
  metadata?: ManagedBoundaryMetadata;
};

type ResidualBucket = {
  boundary_bytes: number;
  classified_boundary_bytes: number;
  classified_categories: Partial<
    Record<ManagedBoundaryClassifiedCategory, number>
  >;
  metadata?: ManagedBoundaryMetadata;
};

type ResidualProjectState = Map<number, ResidualBucket>;

type ConfigureOptions = {
  bucketMs?: number;
  graceMs?: number;
};

const DEFAULT_BUCKET_MS = Math.max(
  1000,
  Number(
    process.env.COCALC_PROJECT_HOST_RAW_NETWORK_RESIDUAL_BUCKET_MS ?? 5000,
  ),
);
const DEFAULT_GRACE_MS = Math.max(
  DEFAULT_BUCKET_MS,
  Number(
    process.env.COCALC_PROJECT_HOST_RAW_NETWORK_RESIDUAL_GRACE_MS ?? 15000,
  ),
);

function normalizePositiveInt(
  value: number | undefined,
  fallback: number,
): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return fallback;
  }
  return n;
}

function bucketStartFor(at: number, bucketMs: number): number {
  return Math.floor(Math.max(0, at) / bucketMs) * bucketMs;
}

export class ManagedProjectEgressResidualTracker {
  private bucketMs: number;
  private graceMs: number;
  private readonly state = new Map<string, ResidualProjectState>();

  constructor({
    bucketMs = DEFAULT_BUCKET_MS,
    graceMs = DEFAULT_GRACE_MS,
  }: ConfigureOptions = {}) {
    this.bucketMs = normalizePositiveInt(bucketMs, DEFAULT_BUCKET_MS);
    this.graceMs = Math.max(
      this.bucketMs,
      normalizePositiveInt(graceMs, DEFAULT_GRACE_MS),
    );
  }

  configure({ bucketMs, graceMs }: ConfigureOptions): void {
    const nextBucketMs = normalizePositiveInt(bucketMs, this.bucketMs);
    const nextGraceMs = Math.max(
      nextBucketMs,
      normalizePositiveInt(graceMs, this.graceMs),
    );
    if (nextBucketMs === this.bucketMs && nextGraceMs === this.graceMs) {
      return;
    }
    this.bucketMs = nextBucketMs;
    this.graceMs = nextGraceMs;
    this.reset();
  }

  noteBoundaryBytes({
    project_id,
    bytes,
    at = Date.now(),
    metadata,
  }: {
    project_id: string;
    bytes: number;
    at?: number;
    metadata?: ManagedBoundaryMetadata;
  }): void {
    const normalizedBytes = Math.floor(Number(bytes) || 0);
    if (!project_id || normalizedBytes <= 0) return;
    const bucket = this.getBucket(project_id, at);
    bucket.boundary_bytes += normalizedBytes;
    if (metadata) {
      bucket.metadata = {
        ...bucket.metadata,
        ...metadata,
      };
    }
  }

  noteBoundaryClassifiedBytes({
    project_id,
    category,
    bytes,
    at = Date.now(),
  }: {
    project_id: string;
    category: ManagedBoundaryClassifiedCategory;
    bytes: number;
    at?: number;
  }): void {
    const normalizedBytes = Math.floor(Number(bytes) || 0);
    if (!project_id || normalizedBytes <= 0) return;
    const bucket = this.getBucket(project_id, at);
    bucket.classified_boundary_bytes += normalizedBytes;
    bucket.classified_categories[category] =
      (bucket.classified_categories[category] ?? 0) + normalizedBytes;
  }

  flush({
    now = Date.now(),
  }: {
    now?: number;
  } = {}): ManagedRawNetworkResidualSample[] {
    const cutoff = Math.max(0, now - this.graceMs - this.bucketMs);
    const out: ManagedRawNetworkResidualSample[] = [];

    for (const [project_id, projectBuckets] of this.state) {
      for (const [bucket_start, bucket] of projectBuckets) {
        if (bucket_start > cutoff) continue;
        const residual = Math.max(
          0,
          bucket.boundary_bytes - bucket.classified_boundary_bytes,
        );
        if (residual > 0) {
          out.push({
            project_id,
            bytes: residual,
            bucket_start,
            bucket_ms: this.bucketMs,
            boundary_bytes: bucket.boundary_bytes,
            classified_boundary_bytes: bucket.classified_boundary_bytes,
            classified_categories: { ...bucket.classified_categories },
            metadata: bucket.metadata ? { ...bucket.metadata } : undefined,
          });
        }
        projectBuckets.delete(bucket_start);
      }
      if (projectBuckets.size === 0) {
        this.state.delete(project_id);
      }
    }

    return out.sort((a, b) =>
      a.project_id === b.project_id
        ? a.bucket_start - b.bucket_start
        : a.project_id.localeCompare(b.project_id),
    );
  }

  reset(): void {
    this.state.clear();
  }

  getConfig(): { bucketMs: number; graceMs: number } {
    return {
      bucketMs: this.bucketMs,
      graceMs: this.graceMs,
    };
  }

  private getBucket(project_id: string, at: number): ResidualBucket {
    let projectBuckets = this.state.get(project_id);
    if (!projectBuckets) {
      projectBuckets = new Map();
      this.state.set(project_id, projectBuckets);
    }
    const bucket_start = bucketStartFor(at, this.bucketMs);
    let bucket = projectBuckets.get(bucket_start);
    if (!bucket) {
      bucket = {
        boundary_bytes: 0,
        classified_boundary_bytes: 0,
        classified_categories: {},
      };
      projectBuckets.set(bucket_start, bucket);
    }
    return bucket;
  }
}

export const managedProjectEgressResidualTracker =
  new ManagedProjectEgressResidualTracker();

export const MANAGED_BOUNDARY_CLASSIFIED_CATEGORIES: ReadonlySet<ManagedProjectEgressCategory> =
  new Set<ManagedProjectEgressCategory>(["http-proxy", "ws-proxy", "ssh"]);
