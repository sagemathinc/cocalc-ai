/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import type { Client } from "@cocalc/conat/core/client";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";

export interface ProjectHostRoutingApi {
  resolveHostConnection(opts: { host_id: string }): Promise<HostConnectionInfo>;
  issueProjectHostAuthToken(opts: {
    host_id: string;
    project_id: string;
    ttl_seconds?: number;
  }): Promise<{ host_id: string; token: string; expires_at: number }>;
}

export interface ProjectHostClientFactoryOptions {
  address: string;
  account_id: string;
  project_id: string;
  host_id: string;
  bearer_token: string;
  host_session_id?: string;
  local_proxy?: boolean;
}

export type ProjectHostClientFactory = (
  opts: ProjectHostClientFactoryOptions,
) => Promise<Client> | Client;

export interface ProjectHostClientLease {
  client: Client;
  project_id: string;
  host_id: string;
  address: string;
  host_session_id?: string;
}

interface CachedLease extends ProjectHostClientLease {
  lastUsedAt: number;
}

interface TokenState {
  hostId: string;
  token?: string;
  expiresAt?: number;
  projectId: string;
  inFlight?: Promise<string>;
  failures: number;
  retryAfter?: number;
}

export interface ProjectHostClientManagerOptions {
  account_id: string;
  api: ProjectHostRoutingApi;
  createClient: ProjectHostClientFactory;
  resolveAddress?: (opts: {
    connection: HostConnectionInfo;
    project_id: string;
  }) => string | undefined;
  now?: () => number;
  maxClients?: number;
  tokenTtlLeewayMs?: number;
  tokenTtlSeconds?: number;
  retryBackoffMs?: readonly number[];
}

const DEFAULT_RETRY_BACKOFF_MS = [1_000, 3_000, 7_000] as const;

function tokenKey(host_id: string, project_id: string): string {
  return `${host_id}\u0000${project_id}`;
}

export class ProjectHostClientManager {
  private readonly account_id: string;
  private readonly api: ProjectHostRoutingApi;
  private readonly createClient: ProjectHostClientFactory;
  private readonly resolveAddress: NonNullable<
    ProjectHostClientManagerOptions["resolveAddress"]
  >;
  private readonly now: () => number;
  private readonly maxClients: number;
  private readonly tokenTtlLeewayMs: number;
  private readonly tokenTtlSeconds?: number;
  private readonly retryBackoffMs: readonly number[];
  private readonly leases = new Map<string, CachedLease>();
  private readonly tokens = new Map<string, TokenState>();
  private readonly inFlight = new Map<
    string,
    Promise<ProjectHostClientLease>
  >();
  private closed = false;

  constructor({
    account_id,
    api,
    createClient,
    resolveAddress = ({ connection }) =>
      connection.connect_url?.trim() || undefined,
    now = Date.now,
    maxClients = 4,
    tokenTtlLeewayMs = 60_000,
    tokenTtlSeconds,
    retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS,
  }: ProjectHostClientManagerOptions) {
    if (!account_id) throw new Error("account_id is required");
    if (maxClients < 1) throw new Error("maxClients must be positive");
    this.account_id = account_id;
    this.api = api;
    this.createClient = createClient;
    this.resolveAddress = resolveAddress;
    this.now = now;
    this.maxClients = maxClients;
    this.tokenTtlLeewayMs = tokenTtlLeewayMs;
    this.tokenTtlSeconds = tokenTtlSeconds;
    this.retryBackoffMs = retryBackoffMs;
  }

  async getClient({
    project_id,
    host_id,
  }: {
    project_id: string;
    host_id: string;
  }): Promise<ProjectHostClientLease> {
    if (this.closed) throw new Error("project-host client manager is closed");
    if (!project_id || !host_id) {
      throw new Error("project_id and host_id are required");
    }
    const pending = this.inFlight.get(project_id);
    if (pending) return await pending;
    const request = this.createLease({ project_id, host_id }).finally(() => {
      if (this.inFlight.get(project_id) === request) {
        this.inFlight.delete(project_id);
      }
    });
    this.inFlight.set(project_id, request);
    return await request;
  }

  private async createLease({
    project_id,
    host_id,
  }: {
    project_id: string;
    host_id: string;
  }): Promise<ProjectHostClientLease> {
    const connection = await this.api.resolveHostConnection({ host_id });
    if (connection.host_id !== host_id) {
      throw new Error("project-host routing returned a different host");
    }
    if (connection.ready === false) {
      throw new Error(
        connection.reason_unavailable ||
          "The selected project host is not ready.",
      );
    }
    const address = this.resolveAddress({ connection, project_id });
    if (!address) {
      throw new Error(
        "The selected project host has no client connection URL.",
      );
    }
    const current = this.leases.get(project_id);
    const sameRoute =
      current?.host_id === host_id &&
      current.address === address &&
      current.host_session_id === connection.host_session_id;
    if (current && sameRoute) {
      current.lastUsedAt = this.now();
      return current;
    }
    if (current) this.removeLease(project_id);

    const bearer_token = await this.getToken({ host_id, project_id });
    let client: Client;
    try {
      client = await this.createClient({
        address,
        account_id: this.account_id,
        project_id,
        host_id,
        bearer_token,
        host_session_id: connection.host_session_id,
        local_proxy: connection.local_proxy === true,
      });
    } catch (err) {
      this.noteTokenFailure(host_id, project_id);
      throw err;
    }
    const lease: CachedLease = {
      client,
      project_id,
      host_id,
      address,
      host_session_id: connection.host_session_id,
      lastUsedAt: this.now(),
    };
    this.leases.set(project_id, lease);
    this.evictLeastRecentlyUsed();
    return lease;
  }

  private async getToken({
    host_id,
    project_id,
  }: {
    host_id: string;
    project_id: string;
  }): Promise<string> {
    const now = this.now();
    const key = tokenKey(host_id, project_id);
    let state = this.tokens.get(key);
    if (!state) {
      state = { failures: 0, hostId: host_id, projectId: project_id };
      this.tokens.set(key, state);
    }
    if (
      state.token &&
      state.expiresAt != null &&
      now < state.expiresAt - this.tokenTtlLeewayMs
    ) {
      return state.token;
    }
    if (state.inFlight) return await state.inFlight;
    if (state.retryAfter != null && now < state.retryAfter) {
      const error = new Error("Project-host authentication is cooling down.");
      (error as Error & { retry_after?: number }).retry_after =
        state.retryAfter;
      throw error;
    }
    const request = this.api
      .issueProjectHostAuthToken({
        host_id,
        project_id,
        ttl_seconds: this.tokenTtlSeconds,
      })
      .then((issued) => {
        if (issued.host_id !== host_id) {
          throw new Error("project-host token was issued for a different host");
        }
        state!.token = issued.token;
        state!.expiresAt = issued.expires_at;
        state!.failures = 0;
        state!.retryAfter = undefined;
        return issued.token;
      })
      .catch((err) => {
        this.noteTokenFailure(host_id, project_id);
        throw err;
      })
      .finally(() => {
        if (state?.inFlight === request) state.inFlight = undefined;
      });
    state.inFlight = request;
    return await request;
  }

  private noteTokenFailure(host_id: string, project_id: string): void {
    const key = tokenKey(host_id, project_id);
    const state = this.tokens.get(key) ?? {
      failures: 0,
      hostId: host_id,
      projectId: project_id,
    };
    state.token = undefined;
    state.expiresAt = undefined;
    state.failures += 1;
    const index = Math.min(state.failures - 1, this.retryBackoffMs.length - 1);
    const delay = this.retryBackoffMs[index] ?? 0;
    state.retryAfter = this.now() + delay;
    this.tokens.set(key, state);
  }

  invalidateProject(project_id: string): void {
    this.removeLease(project_id);
  }

  invalidateHost(host_id: string): void {
    for (const [key, state] of this.tokens) {
      if (state.hostId === host_id) this.tokens.delete(key);
    }
    for (const [projectId, lease] of this.leases) {
      if (lease.host_id === host_id) this.removeLease(projectId);
    }
  }

  suspend(): void {
    for (const projectId of [...this.leases.keys()]) {
      this.removeLease(projectId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.suspend();
    this.tokens.clear();
  }

  private removeLease(project_id: string): void {
    const lease = this.leases.get(project_id);
    this.leases.delete(project_id);
    try {
      lease?.client.close();
    } catch {}
  }

  private evictLeastRecentlyUsed(): void {
    while (this.leases.size > this.maxClients) {
      let oldest: CachedLease | undefined;
      for (const lease of this.leases.values()) {
        if (!oldest || lease.lastUsedAt < oldest.lastUsedAt) oldest = lease;
      }
      if (!oldest) return;
      this.removeLease(oldest.project_id);
    }
  }
}
