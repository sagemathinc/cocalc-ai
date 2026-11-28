/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  ARTIFACT_CATALOG_LIMIT_ERRORS,
  type ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";
import { BoundedMap, LogRateLimiter } from "../log-rate-limit";
import type { ArtifactCatalogService } from "./service";

type ServiceOptions = ConstructorParameters<typeof ArtifactCatalogService>[0];
type LimitScope = "project" | "source";

const LIMIT_SCOPES = new Map<string, LimitScope>([
  [ARTIFACT_CATALOG_LIMIT_ERRORS.projectMetadata, "project"],
  [ARTIFACT_CATALOG_LIMIT_ERRORS.projectMutationBudget, "project"],
  [ARTIFACT_CATALOG_LIMIT_ERRORS.projectSources, "project"],
  [ARTIFACT_CATALOG_LIMIT_ERRORS.projectOwnerUnavailable, "project"],
  [ARTIFACT_CATALOG_LIMIT_ERRORS.sourceReadLimit, "source"],
]);

const MAX_LOGGED_ERROR_LENGTH = 300;

/** Thrown instead of reading or sending while a project or source backs off. */
export class ArtifactCatalogBackoffError extends Error {
  readonly code = "ARTIFACT_CATALOG_BACKOFF";
  constructor() {
    super("artifact catalog indexing is backing off");
  }
}

// Wrappers that may sit around an owner's error message: callHub's suffix,
// at most one inter-bay service client prefix for a catalog writer method,
// and stringified Error prefixes. Nothing else is stripped.
const CALL_HUB_SUFFIX =
  / - callHub: subject='[^']*', name='[^']*', code='[^']*'$/;
const REMOTE_PREFIX =
  /^calling remote function '(?:writerState|registerSource|ingest|sourcePage)': /;
const ERROR_PREFIX = /^(?:Error: )+/;

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : `${error}`)
    .replace(CALL_HUB_SUFFIX, "")
    .replace(ERROR_PREFIX, "")
    .replace(REMOTE_PREFIX, "")
    .replace(ERROR_PREFIX, "");
}

/** Exact-match classification; any other error keeps the journal's retry. */
export function artifactCatalogLimitScope(
  error: unknown,
): LimitScope | undefined {
  return LIMIT_SCOPES.get(errorMessage(error));
}

/** Log fields that never include snapshot items or chat content. */
export function artifactCatalogLogFields(
  source: ArtifactCatalogSource | undefined,
  error: unknown,
) {
  const message = errorMessage(error);
  return {
    project_id: source?.project_id,
    chat_path: source?.chat_path,
    error:
      message.length > MAX_LOGGED_ERROR_LENGTH
        ? `${message.slice(0, MAX_LOGGED_ERROR_LENGTH)}...`
        : message,
  };
}

/**
 * In-memory per-project/per-source backoff for capacity errors. Chat writes
 * reset the journal's own retry state, so this must live outside the journal.
 */
export class ArtifactCatalogBackoff {
  private readonly state: BoundedMap<{
    failures: number;
    until: number;
    trigger: string;
  }>;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor({
    baseMs = 60_000,
    maxMs = 60 * 60_000,
    maxKeys = 1000,
    now = () => Date.now(),
  }: {
    baseMs?: number;
    maxMs?: number;
    maxKeys?: number;
    now?: () => number;
  } = {}) {
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.now = now;
    this.state = new BoundedMap(maxKeys);
  }

  private keys(source: ArtifactCatalogSource) {
    return [
      `project:${source.project_id}`,
      `source:${source.project_id}:${source.chat_path}`,
    ];
  }

  /** Throws ArtifactCatalogBackoffError while the project or source waits. */
  check(source: ArtifactCatalogSource) {
    const now = this.now();
    for (const key of this.keys(source)) {
      const entry = this.state.get(key);
      if (entry && now < entry.until) throw new ArtifactCatalogBackoffError();
    }
  }

  /** Records a capacity failure; undefined means the error does not back off. */
  failure(source: ArtifactCatalogSource | undefined, error: unknown) {
    if (!source) return;
    const scope = artifactCatalogLimitScope(error);
    if (!scope) return;
    const [projectKey, sourceKey] = this.keys(source);
    const key = scope === "project" ? projectKey : sourceKey;
    const failures = (this.state.get(key)?.failures ?? 0) + 1;
    const retry_in_ms = Math.min(
      this.maxMs,
      this.baseMs * 2 ** Math.min(failures - 1, 20),
    );
    this.state.set(key, {
      failures,
      until: this.now() + retry_in_ms,
      trigger: sourceKey,
    });
    return { scope, failures, retry_in_ms };
  }

  /**
   * A completed read clears its source. A committed delivery clears the
   * project only when it is the source that failed: unchanged-metadata
   * deliveries succeed even while the project is over its cap.
   */
  success(source: ArtifactCatalogSource, scope: "source" | "all") {
    const [projectKey, sourceKey] = this.keys(source);
    this.state.delete(sourceKey);
    if (scope === "all" && this.state.get(projectKey)?.trigger === sourceKey)
      this.state.delete(projectKey);
  }

  get size() {
    return this.state.size;
  }
}

/**
 * Wraps a catalog adapter's transport (read, send, registration and writer
 * lookups): capacity errors back off per project
 * (or per source for oversized chats) up to an hour, and failures are logged
 * as compact, rate-limited lines instead of whole snapshots.
 */
export function withArtifactCatalogBackoff<
  T extends Pick<ServiceOptions, "read" | "send" | "register" | "writerState">,
>(
  options: T,
  logger: { warn: (...args: any[]) => void },
  backoff = new ArtifactCatalogBackoff(),
  limiter = new LogRateLimiter(),
): NoInfer<T> & Pick<ServiceOptions, "onError"> {
  return {
    ...options,
    read: async (source: Parameters<ServiceOptions["read"]>[0]) => {
      backoff.check(source);
      const items = await options.read(source);
      backoff.success(source, "source");
      return items;
    },
    send: async (snapshot: Parameters<ServiceOptions["send"]>[0]) => {
      backoff.check(snapshot);
      await options.send(snapshot);
      backoff.success(snapshot, "all");
    },
    // Lookups only wait: a found writer is not proof the project recovered.
    writerState: async (
      source: Parameters<ServiceOptions["writerState"]>[0],
    ) => {
      backoff.check(source);
      return await options.writerState(source);
    },
    register: async (request: Parameters<ServiceOptions["register"]>[0]) => {
      backoff.check(request);
      const result = await options.register(request);
      backoff.success(request, "all");
      return result;
    },
    onError: (source: ArtifactCatalogSource | undefined, error: unknown) => {
      if (error instanceof ArtifactCatalogBackoffError) return;
      const fields = artifactCatalogLogFields(source, error);
      const delay = backoff.failure(source, error);
      if (delay) {
        logger.warn("catalog indexing backed off", { ...fields, ...delay });
        return;
      }
      const suppressed = limiter.take(
        JSON.stringify([fields.project_id, fields.chat_path, fields.error]),
      );
      if (suppressed == null) return;
      logger.warn("catalog indexing deferred", {
        ...fields,
        ...(suppressed ? { suppressed } : {}),
      });
    },
  };
}
