import { redux } from "@cocalc/frontend/app-framework";
import type { WebappClient } from "@cocalc/frontend/client/client";
import { withTimeout } from "@cocalc/util/async-utils";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import {
  type ConatSyncTable,
  ConatSyncTableFunction,
} from "@cocalc/conat/sync/synctable";
import { randomId, inboxPrefix } from "@cocalc/conat/names";
import { projectSubject } from "@cocalc/conat/names";
import { parseQueryWithOptions } from "@cocalc/sync/table/util";
import { type HubApi, initHubApi } from "@cocalc/conat/hub/api";
import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import { type ProjectApi, projectApiClient } from "@cocalc/conat/project/api";
import { isValidUUID } from "@cocalc/util/misc";
import { handleErrorMessage } from "@cocalc/conat/util";
import { PubSub } from "@cocalc/conat/sync/pubsub";
import type { ChatOptions } from "@cocalc/util/types/llm";
import { dkv } from "@cocalc/conat/sync/dkv";
import { akv } from "@cocalc/conat/sync/akv";
import { astream } from "@cocalc/conat/sync/astream";
import { dko } from "@cocalc/conat/sync/dko";
import { dstream } from "@cocalc/conat/sync/dstream";
import { callConatService, createConatService } from "@cocalc/conat/service";
import type {
  CallConatServiceFunction,
  CreateConatServiceFunction,
} from "@cocalc/conat/service";
import { listingsClient } from "@cocalc/conat/service/listings";
import getTime, { getSkew, init as initTime } from "@cocalc/conat/time";
import { llm as requestLlm } from "@cocalc/conat/llm/client";
import * as acp from "@cocalc/conat/ai/acp/client";
import { inventory } from "@cocalc/conat/sync/inventory";
import { EventEmitter } from "events";
import {
  getClient as getClientWithState,
  setConatClient,
  type ClientWithState,
} from "@cocalc/conat/client";
import Cookies from "js-cookie";
import { ACCOUNT_ID_COOKIE } from "@cocalc/frontend/client/client";
import { info as refCacheInfo } from "@cocalc/util/refcache";
import { connect as connectToConat } from "@cocalc/conat/core/client";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  clearStoredControlPlaneOrigin,
  getControlPlaneAppUrl,
  getStoredControlPlaneOrigin,
  normalizeControlPlaneOrigin,
  setStoredControlPlaneOrigin,
} from "@cocalc/frontend/control-plane-origin";
import { getAuthBootstrap } from "@cocalc/frontend/auth/api";
import type { ConnectionStats } from "@cocalc/conat/core/types";
import { delay } from "awaiting";
import type {
  AgentExecuteRequest,
  AgentExecuteResponse,
  AgentManifestEntry,
  AgentPlanRequest,
  AgentPlanResponse,
  AgentRunRequest,
  AgentRunResponse,
} from "@cocalc/conat/hub/api/agent";
import {
  deleteRememberMe,
  setRememberMe,
} from "@cocalc/frontend/misc/remember-me";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import {
  get as getLroStream,
  waitForCompletion as waitForLroCompletion,
} from "@cocalc/conat/lro/client";
import { terminalClient } from "@cocalc/conat/project/terminal";
import { lite } from "@cocalc/frontend/lite";
import type {
  LroEvent,
  LroScopeType,
  LroSummary,
} from "@cocalc/conat/hub/api/lro";
import type { Map as ImmutableMap } from "immutable";
import type { DStreamOptions } from "@cocalc/conat/sync/dstream";
import type { DKVOptions } from "@cocalc/conat/sync/dkv";
import {
  createBrowserSessionAutomation,
  type BrowserSessionAutomation,
} from "./browser-session";
import { routeProjectHostHttpUrl } from "./project-host-route";
import {
  ReconnectCoordinator,
  type ReconnectPriority,
  type ReconnectResourceOptions,
  type RegisteredReconnectResource,
} from "./reconnect-coordinator";
import { disconnect_from_all_projects } from "@cocalc/frontend/project/websocket/connect";

export interface ConatConnectionStatus {
  state: "connected" | "connecting" | "disconnected";
  reason: string;
  details: any;
  stats: ConnectionStats;
}

export type ConnectionTargetKind = "hub" | "project-host";

export interface ConnectionTargetSnapshot {
  id: string;
  kind: ConnectionTargetKind;
  label: string;
  address?: string;
  status: ConatConnectionStatus;
}

const DEFAULT_TIMEOUT = 15000;
const AGENT_MANIFEST_TIMEOUT = 60_000;
const AGENT_EXECUTE_TIMEOUT = 10 * 60_000;
const AGENT_PLAN_TIMEOUT = 10 * 60_000;
const AGENT_RUN_TIMEOUT = 20 * 60_000;

const DEBUG = false;
const PROJECT_HOST_ROUTED_HUB_METHODS = new Set<string>([
  "projects.codexDeviceAuthStart",
  "projects.codexDeviceAuthStatus",
  "projects.codexDeviceAuthCancel",
  "projects.codexUploadAuthFile",
  "projects.chatStoreStats",
  "projects.chatStoreRotate",
  "projects.chatStoreListSegments",
  "projects.chatStoreReadArchived",
  "projects.chatStoreReadArchivedHit",
  "projects.chatStoreSearch",
  "projects.chatStoreDelete",
  "projects.chatStoreVacuum",
]);
const PROJECT_HOST_ROUTED_HUB_METHODS_WITH_HUB_FALLBACK = new Set<string>([]);
const PROJECT_HOST_ROUTED_HUB_METHODS_WITH_LITE_HUB_FALLBACK = new Set<string>([
  "projects.codexDeviceAuthStart",
  "projects.codexDeviceAuthStatus",
  "projects.codexDeviceAuthCancel",
  "projects.codexUploadAuthFile",
  "projects.chatStoreStats",
  "projects.chatStoreRotate",
  "projects.chatStoreListSegments",
  "projects.chatStoreReadArchived",
  "projects.chatStoreReadArchivedHit",
  "projects.chatStoreSearch",
  "projects.chatStoreDelete",
  "projects.chatStoreVacuum",
]);
const PROJECT_HOST_TOKEN_TTL_LEEWAY_MS = 60_000;
const PROJECT_HOST_TOKEN_FAILURE_BACKOFF_MS = [3_000, 10_000, 30_000] as const;
const PROJECT_HOST_ROUTING_REFRESH_TIMEOUT_MS = 5_000;
const ROUTED_HOST_REBUILD_AFTER_ATTEMPTS = 3;
const FOREGROUND_WAKE_RECONNECT_THRESHOLD_MS = 60_000;
const FOREGROUND_WAKE_PING_TIMEOUT_MS = 3_000;
const EMPTY_CONNECTION_STATS: ConnectionStats = {
  send: { messages: 0, bytes: 0 },
  recv: { messages: 0, bytes: 0 },
  subs: 0,
};
type RoutedHubClientState = {
  address: string;
  host_session_id?: string;
  project_ids: Set<string>;
  last_project_id?: string;
  client: ReturnType<typeof connectToConat>;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  connectInFlight?: Promise<boolean>;
  reconnectAttempts: number;
};

type ProjectHostTokenState = {
  token?: string;
  expiresAt?: number;
  inFlight?: Promise<string>;
  failureCount?: number;
  retryAfter?: number;
  lastError?: any;
  lastProjectId?: string;
};

export class ConatClient extends EventEmitter {
  client: WebappClient;
  public hub: HubApi;
  public sessionId = randomId();
  private clientWithState: ClientWithState;
  private _conatClient: null | ReturnType<typeof connectToConat>;
  private routedHubClients: { [host_id: string]: RoutedHubClientState } = {};
  private projectHostTokens: { [host_id: string]: ProjectHostTokenState } = {};
  private routedHostRecoveryTimer?: ReturnType<typeof setTimeout>;
  private browserSessionAutomation: BrowserSessionAutomation;
  private reconnectCoordinator: ReconnectCoordinator;
  private lastBackgroundAt?: number;
  private foregroundWakeRecovery?: Promise<void>;
  private staleHubProbe?: Promise<void>;
  public numConnectionAttempts = 0;
  private automaticallyReconnect;
  public address: string;
  private remote: boolean;
  private reconnectDebugContext = () => ({
    online:
      typeof navigator === "undefined" ? undefined : navigator.onLine !== false,
    visibility:
      typeof document === "undefined" ? undefined : document.visibilityState,
    focused:
      typeof document === "undefined" || typeof document.hasFocus !== "function"
        ? undefined
        : document.hasFocus(),
    automaticallyReconnect: !!this.automaticallyReconnect,
    hubConnected: !!this._conatClient?.conn?.connected,
    routedHosts: Object.entries(this.routedHubClients).map(
      ([host_id, state]) => ({
        host_id,
        connected: !!state.client?.conn?.connected,
        reconnecting: state.reconnectTimer != null,
        reconnectAttempts: state.reconnectAttempts,
        host_session_id: state.host_session_id,
        project_ids: Array.from(state.project_ids),
      }),
    ),
  });
  private browserOnlinePriority = (): ReconnectPriority => {
    if (typeof document === "undefined") {
      return "foreground";
    }
    return document.visibilityState === "hidden" ? "background" : "foreground";
  };
  private readonly browserOnlineHandler = () => {
    const priority = this.browserOnlinePriority();
    console.log("browser online event", {
      priority,
      tabPriority: this.tabReconnectPriority(),
      ...this.reconnectDebugContext(),
    });
    if (this.permanentlyDisconnected || !this.automaticallyReconnect) {
      return;
    }
    if (
      priority === "foreground" &&
      Object.keys(this.routedHubClients).length > 0
    ) {
      console.log(
        "browser online event; forcing reconnect to rebuild routed host connections",
      );
      this.reconnect();
      return;
    }
    this.requestReconnect({
      reason: "browser_online",
      priority,
      resetBackoff: true,
    });
  };
  private readonly browserOfflineHandler = () => {
    console.warn("browser offline event", this.reconnectDebugContext());
  };
  private readonly foregroundWakeHandler = () => {
    if (this.tabReconnectPriority() !== "foreground") {
      this.lastBackgroundAt = Date.now();
      return;
    }
    void this.maybeRecoverForegroundWake();
  };
  constructor(
    client: WebappClient,
    { address, remote }: { address?: string; remote?: boolean } = {},
  ) {
    super();
    this.address =
      address ?? getControlPlaneAppUrl() ?? location.origin + appBasePath;
    this.remote = !!remote;
    this.setMaxListeners(100);
    this.client = client;
    this.hub = initHubApi(this.callHub);
    this.browserSessionAutomation = createBrowserSessionAutomation({
      client: this.client,
      hub: this.hub,
      conat: this.conat,
    });
    this.reconnectCoordinator = new ReconnectCoordinator({
      canReconnect: () =>
        !this.permanentlyDisconnected && !!this.automaticallyReconnect,
      connect: async () => {
        await this.connect();
      },
      isConnected: () => !!this._conatClient?.conn?.connected,
      onReconnectScheduled: ({ delay_ms, attempt, priority, reason }) => {
        this.numConnectionAttempts = attempt;
        this.client.emit("connecting");
        this.setConnectionStatus({
          state: "connecting",
          reason,
          details: { delay_ms, attempt, priority },
          stats: this._conatClient?.stats,
        });
      },
      onReconnectStable: () => {
        this.numConnectionAttempts = 0;
      },
    });
    this.initConatClient();
    this.on("state", (state) => {
      this.emit(state);
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.foregroundWakeHandler);
      window.addEventListener("focus", this.foregroundWakeHandler);
      window.addEventListener("blur", this.foregroundWakeHandler);
      window.addEventListener("online", this.browserOnlineHandler);
      window.addEventListener("offline", this.browserOfflineHandler);
    }
  }

  private updateAddress = (address: string | undefined) => {
    const normalized = normalizeControlPlaneOrigin(address);
    if (!normalized) {
      return;
    }
    const appUrl = `${normalized}${appBasePath === "/" ? "" : appBasePath}`;
    if (appUrl === this.address) {
      return;
    }
    this.address = appUrl;
    if (this._conatClient == null) {
      return;
    }
    try {
      this._conatClient.disconnect();
    } catch {}
    try {
      this._conatClient.conn?.io?.engine?.close();
    } catch {}
    this._conatClient = null;
  };

  private bootstrapControlPlaneOrigin = reuseInFlight(async () => {
    if (this.remote || typeof window === "undefined") {
      return;
    }
    const stored = getStoredControlPlaneOrigin();
    if (stored) {
      this.updateAddress(stored);
      return;
    }
    const cookie = Cookies.get(ACCOUNT_ID_COOKIE);
    if (!cookie) {
      return;
    }
    try {
      const bootstrap = await getAuthBootstrap();
      const origin = normalizeControlPlaneOrigin(bootstrap.home_bay_url);
      if (!origin) {
        return;
      }
      setStoredControlPlaneOrigin(origin);
      this.updateAddress(origin);
    } catch (err) {
      console.warn(`control-plane bootstrap failed: ${err}`);
    }
  });

  private maybeRecoverForegroundWake = async () => {
    if (this.remote || this.permanentlyDisconnected) {
      return;
    }
    if (!this.automaticallyReconnect || !this.is_signed_in()) {
      return;
    }
    if (this.tabReconnectPriority() !== "foreground") {
      return;
    }
    const hiddenForMs =
      this.lastBackgroundAt == null ? 0 : Date.now() - this.lastBackgroundAt;
    if (hiddenForMs < FOREGROUND_WAKE_RECONNECT_THRESHOLD_MS) {
      return;
    }
    this.lastBackgroundAt = undefined;
    if (this.foregroundWakeRecovery != null) {
      return await this.foregroundWakeRecovery;
    }
    this.foregroundWakeRecovery = (async () => {
      try {
        await this.callHub({
          name: "system.ping",
          args: [],
          timeout: FOREGROUND_WAKE_PING_TIMEOUT_MS,
        });
      } catch (err) {
        if (
          this.permanentlyDisconnected ||
          !this.automaticallyReconnect ||
          this.tabReconnectPriority() !== "foreground"
        ) {
          return;
        }
        console.warn(
          `foreground wake probe failed after ${hiddenForMs}ms hidden; forcing reconnect`,
          err,
        );
        this.reconnect();
      } finally {
        this.foregroundWakeRecovery = undefined;
      }
    })();
    await this.foregroundWakeRecovery;
  };

  private setConnectionStatus = (status: Partial<ConatConnectionStatus>) => {
    const actions = redux?.getActions("page");
    const store = redux?.getStore("page");
    if (actions == null || store == null) {
      return;
    }
    const cur = store.get("conat")?.toJS();
    actions.setState({ conat: { ...cur, ...status } } as any);
  };

  private getHubLabel = (): string => {
    const hubId =
      `${this._conatClient?.info?.id ?? redux.getStore("account")?.get("hub") ?? ""}`.trim();
    return hubId ? `hub ${hubId}` : "hub";
  };

  private getProjectHostLabel = (host_id: string): string => {
    const hostName =
      `${redux.getStore("projects")?.get("host_info")?.get(host_id)?.get?.("name") ?? ""}`.trim();
    if (hostName) {
      return `project-host ${hostName}`;
    }
    return `project-host ${host_id.slice(0, 8)}`;
  };

  private getHubConnectionStatusSnapshot = (): ConatConnectionStatus => {
    const connected = !!this._conatClient?.conn?.connected;
    return {
      state: connected ? "connected" : "disconnected",
      reason: connected ? "" : "transport unavailable",
      details: connected
        ? { address: this.address }
        : {
            address: this.address,
            automaticallyReconnect: !!this.automaticallyReconnect,
          },
      stats: this._conatClient?.stats ?? EMPTY_CONNECTION_STATS,
    };
  };

  private getRoutedHostConnectionStatusSnapshot = (
    host_id: string,
    state: RoutedHubClientState,
  ): ConatConnectionStatus => {
    const connected = !!state.client?.conn?.connected;
    return {
      state: connected
        ? "connected"
        : state.reconnectTimer != null
          ? "connecting"
          : "disconnected",
      reason: connected
        ? ""
        : state.reconnectTimer != null
          ? "reconnecting"
          : "transport unavailable",
      details: {
        host_id,
        address: state.address,
        host_session_id: state.host_session_id,
        project_ids: Array.from(state.project_ids),
      },
      stats: state.client?.stats ?? EMPTY_CONNECTION_STATS,
    };
  };

  getConnectionTargets = (): ConnectionTargetSnapshot[] => {
    const targets: ConnectionTargetSnapshot[] = [
      {
        id: "hub",
        kind: "hub",
        label: this.getHubLabel(),
        address: this.address,
        status: this.getHubConnectionStatusSnapshot(),
      },
    ];
    for (const [host_id, state] of Object.entries(this.routedHubClients)) {
      if (!state.client?.conn?.connected) {
        continue;
      }
      targets.push({
        id: `project-host:${host_id}`,
        kind: "project-host",
        label: this.getProjectHostLabel(host_id),
        address: state.address,
        status: this.getRoutedHostConnectionStatusSnapshot(host_id, state),
      });
    }
    return targets;
  };

  probeConnectionTarget = async (
    targetId: string,
    timeout = FOREGROUND_WAKE_PING_TIMEOUT_MS,
  ): Promise<number | undefined> => {
    const started = Date.now();
    if (targetId === "hub") {
      await this.callHub({
        name: "system.ping",
        args: [],
        timeout,
      });
      return Date.now() - started;
    }
    const prefix = "project-host:";
    if (!targetId.startsWith(prefix)) {
      return;
    }
    const host_id = targetId.slice(prefix.length);
    const state = this.routedHubClients[host_id];
    if (!state?.client?.conn?.connected) {
      return;
    }
    await state.client.request(
      `hub.account.${this.client.account_id}.api`,
      { name: "system.ping", args: [] },
      { timeout },
    );
    return Date.now() - started;
  };

  conat = () => {
    if (this._conatClient == null) {
      this.startStatsReporter();
      this._conatClient = connectToConat({
        address: this.address,
        inboxPrefix: inboxPrefix({ account_id: this.client.account_id }),
        auth: (cb) => cb({ browser_id: this.client.browser_id }),
        withCredentials: true,
        routeSubject: (subject: string) => {
          const project_id = this.extractProjectIdFromSubject(subject);
          if (!project_id) {
            return;
          }
          const routing = this.getProjectRoutingInfo(project_id);
          if (!routing) {
            return;
          }
          return {
            client: this.getOrCreateRoutedHubClient({
              ...routing,
              project_id,
            }),
          };
        },
        // it is necessary to manually managed reconnects due to a bugs
        // in socketio that has stumped their devs
        //   -- https://github.com/socketio/socket.io/issues/5197
        reconnection: false,
      });
      this._conatClient.on("connected", () => {
        console.log("hub transport connected", this.reconnectDebugContext());
        this.reconnectCoordinator.noteConnected();
        this.browserSessionAutomation.noteConnected?.();
        this.setConnectionStatus({
          state: "connected",
          reason: "",
          details: "",
          stats: this._conatClient?.stats,
        });
        this.client.emit("connected");
        this.automaticallyReconnect = true;
      });
      this._conatClient.on("disconnected", (reason, details) => {
        console.warn("hub transport disconnected", {
          reason,
          details,
          ...this.reconnectDebugContext(),
        });
        this.browserSessionAutomation.noteDisconnected?.();
        this.setConnectionStatus({
          state: "disconnected",
          reason,
          details,
          stats: this._conatClient?.stats,
        });
        this.client.emit("disconnected", "offline");
        if (this.automaticallyReconnect) {
          this.reconnectCoordinator.requestReconnect({
            reason: `transport_disconnected:${reason ?? "unknown"}`,
            priority: this.tabReconnectPriority(),
          });
        }
      });
      this._conatClient.conn.on("connect_error", (err) => {
        console.warn("hub transport connect_error", {
          err,
          ...this.reconnectDebugContext(),
        });
        this.browserSessionAutomation.noteDisconnected?.();
        if (!this.automaticallyReconnect) {
          return;
        }
        this.setConnectionStatus({
          state: "disconnected",
          reason: "connect_error",
          details: err,
          stats: this._conatClient?.stats,
        });
        this.reconnectCoordinator.requestReconnect({
          reason: "connect_error",
          priority: this.tabReconnectPriority(),
        });
      });
    }
    return this._conatClient!;
  };

  private tabReconnectPriority = (): ReconnectPriority => {
    if (typeof document === "undefined") {
      return "foreground";
    }
    if (document.visibilityState === "hidden") {
      return "background";
    }
    if (typeof document.hasFocus === "function" && !document.hasFocus()) {
      return "background";
    }
    return "foreground";
  };

  // Match project subjects in the same way the server auth does:
  //   - "project.<uuid>.<...>"
  //   - "*.project-<uuid>.<...>"
  // See src/packages/server/conat/socketio/auth.ts
  private extractProjectIdFromSubject(subject: string): string | undefined {
    if (subject.startsWith("project.")) {
      const project_id = subject.split(".")[1];
      if (isValidUUID(project_id)) {
        return project_id;
      }
    } else {
      const parts = subject.split(".");
      if (
        parts[0] === "services" &&
        parts[1]?.startsWith("account-") &&
        isValidUUID(parts[3] ?? "")
      ) {
        return parts[3];
      }
      const maybe = parts[1];
      if (maybe?.startsWith("project-")) {
        const project_id = maybe.slice("project-".length);
        if (isValidUUID(project_id)) {
          return project_id;
        }
      }
    }
    return undefined;
  }

  private getHostInfo(host_id: string): ImmutableMap<string, any> | undefined {
    const hostInfo = redux.getStore("projects")?.get("host_info")?.get(host_id);
    if (!hostInfo) {
      redux.getActions("projects")?.ensure_host_info(host_id);
      return;
    }
    const updatedAt = hostInfo.get("updated_at");
    if (typeof updatedAt === "number") {
      if (Date.now() - updatedAt > 60_000) {
        redux.getActions("projects")?.ensure_host_info(host_id);
      }
    }
    return hostInfo;
  }

  private getHostRoutingInfo(
    host_id: string,
  ):
    | undefined
    | { host_id: string; address: string; host_session_id?: string } {
    const hostInfo = this.getHostInfo(host_id);
    return this.buildHostRoutingInfo(host_id, hostInfo);
  }

  private buildHostRoutingInfo(
    host_id: string,
    hostInfo?: ImmutableMap<string, any>,
  ):
    | undefined
    | { host_id: string; address: string; host_session_id?: string } {
    if (!hostInfo) return;
    const localProxy = hostInfo.get("local_proxy");
    let address: string;
    if (localProxy && typeof window !== "undefined") {
      const basePath = appBasePath && appBasePath !== "/" ? appBasePath : "";
      address = `${window.location.origin}${basePath}/${host_id}`;
    } else {
      const connectUrl = hostInfo.get("connect_url");
      address = connectUrl || "";
    }
    if (!address || address === this.address) {
      return;
    }
    const host_session_id = `${hostInfo.get("host_session_id") ?? ""}`.trim();
    return {
      host_id,
      address,
      ...(host_session_id ? { host_session_id } : {}),
    };
  }

  private getProjectRoutingInfo(
    project_id: string,
  ):
    | undefined
    | { host_id: string; address: string; host_session_id?: string } {
    // [ ] TODO: need a ttl cache, since otherwise this gets called
    // on literally every packet sent to the project!
    const project_map = redux.getStore("projects")?.get("project_map");
    const host_id = project_map?.getIn([project_id, "host_id"]) as
      | string
      | undefined;
    if (!host_id) {
      // Fallback: no host yet, so stay on the default connection.
      return;
    }
    const hostInfo = this.getHostInfo(host_id);
    if (!hostInfo) return;
    const projectBayId =
      `${project_map?.getIn([project_id, "owning_bay_id"]) ?? ""}`.trim();
    const hostBayId = `${hostInfo.get("bay_id") ?? ""}`.trim();
    if (projectBayId && hostBayId && projectBayId !== hostBayId) {
      void redux.getActions("projects")?.ensure_host_info(host_id, true);
      return;
    }
    return this.buildHostRoutingInfo(host_id, hostInfo);
  }

  private ensureProjectRoutingInfo = async (
    project_id: string,
  ): Promise<
    undefined | { host_id: string; address: string; host_session_id?: string }
  > => {
    const initial = this.getProjectRoutingInfo(project_id);
    if (initial) return initial;
    const project_map = redux.getStore("projects")?.get("project_map");
    const host_id = project_map?.getIn([project_id, "host_id"]) as
      | string
      | undefined;
    if (!host_id) return;
    const projectBayId =
      `${project_map?.getIn([project_id, "owning_bay_id"]) ?? ""}`.trim();
    const hostBayId =
      `${redux.getStore("projects")?.get("host_info")?.get(host_id)?.get?.("bay_id") ?? ""}`.trim();
    await redux
      .getActions("projects")
      ?.ensure_host_info(
        host_id,
        !!projectBayId && !!hostBayId && projectBayId !== hostBayId,
      );
    return this.getProjectRoutingInfo(project_id);
  };

  private refreshHostRoutingInfo = async (
    host_id: string,
  ): Promise<
    undefined | { host_id: string; address: string; host_session_id?: string }
  > => {
    console.log(`refreshing routed host info for ${host_id}`, {
      host_id,
      ...this.reconnectDebugContext(),
    });
    try {
      await withTimeout(
        Promise.resolve(
          redux.getActions("projects")?.ensure_host_info(host_id, true),
        ),
        PROJECT_HOST_ROUTING_REFRESH_TIMEOUT_MS,
      );
      const routing = this.getHostRoutingInfo(host_id);
      if (routing) {
        console.log(`refreshed routed host info for ${host_id}`, routing);
        return routing;
      }
    } catch (err) {
      console.warn(
        `cached host-info refresh for ${host_id} timed out or failed; resolving directly`,
        err,
      );
    }
    const direct = (await this.callHub({
      name: "hosts.resolveHostConnection",
      args: [{ host_id }],
      timeout: PROJECT_HOST_ROUTING_REFRESH_TIMEOUT_MS,
    })) as HostConnectionInfo | undefined;
    const routing = direct?.connect_url
      ? {
          host_id,
          address: direct.connect_url,
          host_session_id: direct.host_session_id,
        }
      : undefined;
    console.log(`refreshed routed host info for ${host_id}`, {
      direct: true,
      routing,
    });
    return routing;
  };

  private isProjectHostAuthError = (err: any): boolean => {
    const mesg = `${err?.message ?? ""}`.toLowerCase();
    return (
      mesg.includes("missing project-host bearer token") ||
      mesg.includes("project-host auth token") ||
      mesg.includes("jwt") ||
      mesg.includes("unauthorized")
    );
  };

  private isProjectHostAuthBackoffError = (err: any): boolean => {
    return !!err?.projectHostAuthBackoff;
  };

  private isTimeoutLikeError = (err: any): boolean => {
    const code = `${err?.code ?? ""}`.trim();
    const message = `${err?.message ?? err ?? ""}`.toLowerCase();
    return (
      code === "408" ||
      message.includes("timeout") ||
      message.includes("timed out")
    );
  };

  private maybeProbeStaleHubTransport = (reason: string, err: any): void => {
    if (this.staleHubProbe != null || this.permanentlyDisconnected) {
      return;
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    if (!this._conatClient?.conn?.connected || !this.client.account_id) {
      return;
    }
    const subject = `hub.account.${this.client.account_id}.api`;
    this.staleHubProbe = (async () => {
      try {
        console.warn(`probing stale hub transport after ${reason}`, {
          reason,
          err,
          ...this.reconnectDebugContext(),
        });
        await this._conatClient!.request(
          subject,
          { name: "system.ping", args: [] },
          { timeout: 2_000 },
        );
        console.warn(`stale hub transport probe succeeded after ${reason}`);
      } catch (probeErr) {
        if (
          this.permanentlyDisconnected ||
          (typeof navigator !== "undefined" && navigator.onLine === false) ||
          (typeof document !== "undefined" &&
            document.visibilityState === "hidden") ||
          !this._conatClient?.conn?.connected
        ) {
          return;
        }
        console.warn(
          `stale hub transport probe failed after ${reason}; forcing reconnect`,
          probeErr,
        );
        this.reconnect();
      } finally {
        this.staleHubProbe = undefined;
      }
    })();
  };

  private projectHostTokenBackoffMs = (failureCount: number): number => {
    return PROJECT_HOST_TOKEN_FAILURE_BACKOFF_MS[
      Math.min(
        Math.max(0, failureCount - 1),
        PROJECT_HOST_TOKEN_FAILURE_BACKOFF_MS.length - 1,
      )
    ];
  };

  private getProjectHostTokenCooldownError = (
    state: ProjectHostTokenState,
  ): Error => {
    const remainingMs = Math.max(0, (state.retryAfter ?? 0) - Date.now());
    const err: any = new Error(
      `project-host auth token retry cooldown active (${remainingMs}ms remaining)`,
    );
    err.projectHostAuthBackoff = true;
    err.retry_after = state.retryAfter;
    err.cause = state.lastError;
    if (state.lastError?.code != null) {
      err.code = state.lastError.code;
    }
    return err;
  };

  private invalidateProjectHostToken = (
    host_id: string,
    { resetFailureState = false }: { resetFailureState?: boolean } = {},
  ) => {
    const state = this.projectHostTokens[host_id];
    if (!state) {
      return;
    }
    delete state.token;
    delete state.expiresAt;
    if (resetFailureState) {
      delete this.projectHostTokens[host_id];
    }
  };

  private getOpenProjectIdsForHost = (host_id: string): Set<string> => {
    const result = new Set<string>();
    const projectsStore = redux.getStore("projects");
    const openProjects = projectsStore?.get("open_projects");
    const projectMap = projectsStore?.get("project_map");
    openProjects?.forEach?.((project_id: string) => {
      if (projectMap?.getIn?.([project_id, "host_id"]) === host_id) {
        result.add(project_id);
      }
    });
    return result;
  };

  private syncTrackedProjectsForHost = (
    host_id: string,
    state?: RoutedHubClientState,
  ): Set<string> => {
    const current = state ?? this.routedHubClients[host_id];
    if (!current) {
      return new Set();
    }
    const openProjects = this.getOpenProjectIdsForHost(host_id);
    for (const project_id of Array.from(current.project_ids)) {
      if (!openProjects.has(project_id)) {
        current.project_ids.delete(project_id);
      }
    }
    if (
      current.last_project_id &&
      !current.project_ids.has(current.last_project_id)
    ) {
      delete current.last_project_id;
    }
    return current.project_ids;
  };

  private registerTrackedProjectForHost = (
    host_id: string,
    state: RoutedHubClientState,
    project_id?: string,
  ): void => {
    this.syncTrackedProjectsForHost(host_id, state);
    if (!project_id || !isValidUUID(project_id)) {
      return;
    }
    state.project_ids.add(project_id);
    state.last_project_id = project_id;
  };

  private pickTrackedProjectForHost = (
    host_id: string,
    state: RoutedHubClientState,
    preferred_project_id?: string,
  ): string | undefined => {
    this.syncTrackedProjectsForHost(host_id, state);
    if (preferred_project_id && state.project_ids.has(preferred_project_id)) {
      state.last_project_id = preferred_project_id;
      return preferred_project_id;
    }
    if (state.last_project_id && state.project_ids.has(state.last_project_id)) {
      return state.last_project_id;
    }
    for (const project_id of state.project_ids) {
      state.last_project_id = project_id;
      return project_id;
    }
    return undefined;
  };

  private removeRoutedHubClient = (
    host_id: string,
    opts?: { expectedClient?: ReturnType<typeof connectToConat> },
  ) => {
    const current = this.routedHubClients[host_id];
    if (!current) return;
    if (opts?.expectedClient && current.client !== opts.expectedClient) {
      return;
    }
    if (current.reconnectTimer != null) {
      clearTimeout(current.reconnectTimer);
      delete current.reconnectTimer;
    }
    try {
      current.client.close();
    } catch (err) {
      console.warn(`failed closing routed hub client for host ${host_id}`, err);
    }
    delete this.routedHubClients[host_id];
  };

  private maybeReleaseRoutedHubClient = (
    host_id: string,
    state?: RoutedHubClientState,
  ) => {
    const current = state ?? this.routedHubClients[host_id];
    if (!current) return;
    if (this.syncTrackedProjectsForHost(host_id, current).size !== 0) {
      return;
    }
    this.invalidateProjectHostToken(host_id, { resetFailureState: true });
    this.removeRoutedHubClient(host_id, { expectedClient: current.client });
  };

  private scheduleRoutedHostRecovery = () => {
    if (this.permanentlyDisconnected) {
      return;
    }
    if (this.routedHostRecoveryTimer != null) {
      return;
    }
    this.routedHostRecoveryTimer = setTimeout(() => {
      delete this.routedHostRecoveryTimer;
      if (this.permanentlyDisconnected) {
        return;
      }
      this.reconnect();
    }, 50);
  };

  refreshProjectHostRouting = ({
    source_host_id,
    dest_host_id,
  }: {
    source_host_id?: string;
    dest_host_id?: string;
  }) => {
    for (const host_id of [source_host_id, dest_host_id]) {
      if (!host_id) continue;
      this.invalidateProjectHostToken(host_id, { resetFailureState: true });
      this.removeRoutedHubClient(host_id);
    }
  };

  releaseProjectHostRouting = ({ project_id }: { project_id: string }) => {
    if (!isValidUUID(project_id)) {
      return;
    }
    for (const [host_id, state] of Object.entries(this.routedHubClients)) {
      if (!state.project_ids.has(project_id)) {
        continue;
      }
      state.project_ids.delete(project_id);
      if (state.last_project_id === project_id) {
        delete state.last_project_id;
      }
      this.maybeReleaseRoutedHubClient(host_id, state);
    }
  };

  private getProjectHostToken = async ({
    host_id,
    project_id,
  }: {
    host_id: string;
    project_id?: string;
  }): Promise<string> => {
    const now = Date.now();
    let state = this.projectHostTokens[host_id];
    if (
      state?.token &&
      state?.expiresAt &&
      now < state.expiresAt - PROJECT_HOST_TOKEN_TTL_LEEWAY_MS
    ) {
      return state.token;
    }
    if (!state) {
      state = {};
      this.projectHostTokens[host_id] = state;
    }
    if (project_id) {
      state.lastProjectId = project_id;
    }
    if (state.inFlight) {
      console.log(
        `waiting for in-flight project-host auth token for ${host_id}`,
        {
          host_id,
          project_id: project_id ?? state.lastProjectId,
        },
      );
      return await state.inFlight;
    }
    if (state.retryAfter != null && now < state.retryAfter) {
      console.warn(`project-host auth token cooldown active for ${host_id}`, {
        host_id,
        project_id: project_id ?? state.lastProjectId,
        retryAfter: state.retryAfter,
        failureCount: state.failureCount,
      });
      throw this.getProjectHostTokenCooldownError(state);
    }
    const authProjectId = project_id ?? state.lastProjectId;
    console.log(`requesting project-host auth token for ${host_id}`, {
      host_id,
      project_id: authProjectId,
      failureCount: state.failureCount ?? 0,
    });
    const request = (
      this.callHub({
        service: "api",
        name: "hosts.issueProjectHostAuthToken",
        args: [{ host_id, project_id: authProjectId }],
        timeout: DEFAULT_TIMEOUT,
      }) as Promise<{ token: string; expires_at: number }>
    )
      .then(({ token, expires_at }) => {
        state!.token = token;
        state!.expiresAt = expires_at;
        state!.failureCount = 0;
        delete state!.retryAfter;
        delete state!.lastError;
        console.log(`received project-host auth token for ${host_id}`, {
          host_id,
          project_id: authProjectId,
          expires_at,
        });
        return token;
      })
      .catch((err) => {
        delete state!.token;
        delete state!.expiresAt;
        state!.failureCount = (state!.failureCount ?? 0) + 1;
        state!.retryAfter =
          Date.now() + this.projectHostTokenBackoffMs(state!.failureCount);
        state!.lastError = err;
        console.warn(`project-host auth token request failed for ${host_id}`, {
          host_id,
          project_id: authProjectId,
          failureCount: state!.failureCount,
          retryAfter: state!.retryAfter,
          err,
        });
        throw err;
      })
      .finally(() => {
        if (state?.inFlight === request) {
          delete state.inFlight;
        }
      });
    state.inFlight = request;
    return await request;
  };

  // Mint a short-lived project-host auth token for ACP/Codex runtime use.
  // Returns undefined when this project is not project-host routed.
  public getProjectHostAcpBearer = async ({
    project_id,
  }: {
    project_id?: string;
  }): Promise<string | undefined> => {
    const id = `${project_id ?? ""}`.trim();
    if (!id) return;
    const routing = await this.ensureProjectRoutingInfo(id);
    if (!routing?.host_id) return;
    return await this.getProjectHostToken({
      host_id: routing.host_id,
      project_id: id,
    });
  };

  public addProjectHostAuthToUrl = async ({
    project_id,
    url,
  }: {
    project_id: string;
    url: string;
  }): Promise<string> => {
    if (!url) return url;
    const routing = await this.ensureProjectRoutingInfo(project_id);
    if (!routing) return url;
    const routedUrl = routeProjectHostHttpUrl({
      url,
      routingAddress: routing.address,
    });
    // Project-host HTTP/WS proxy auth is enforced on the target host, including
    // local-proxy paths through the hub. Always attach a short-lived bootstrap
    // token so project-host can mint its own HttpOnly session cookie.
    const token = await this.getProjectHostToken({
      host_id: routing.host_id,
      project_id,
    });
    const isAbsolute = /^https?:\/\//i.test(routedUrl);
    const parsed = new URL(
      routedUrl,
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost",
    );
    parsed.searchParams.set(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM, token);
    if (isAbsolute) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  };

  public touchProjectHost = async ({
    project_id,
    timeout = DEFAULT_TIMEOUT,
  }: {
    project_id: string;
    timeout?: number;
  }): Promise<void> => {
    if (!isValidUUID(project_id)) {
      return;
    }
    const routing = await this.ensureProjectRoutingInfo(project_id);
    if (!routing) {
      return;
    }
    const subject = projectSubject({ project_id, service: "touch" });
    let cn = this.getOrCreateRoutedHubClient({ ...routing, project_id });
    try {
      await cn.request(subject, ["touch", []], {
        timeout,
        waitForInterest: true,
      });
    } catch (err) {
      if (!this.isProjectHostAuthError(err)) {
        throw err;
      }
      this.invalidateProjectHostToken(routing.host_id);
      this.removeRoutedHubClient(routing.host_id);
      cn = this.getOrCreateRoutedHubClient({ ...routing, project_id });
      await cn.request(subject, ["touch", []], {
        timeout,
        waitForInterest: true,
      });
    }
  };

  // Project-host routing + auth design:
  // - docs/project-host-auth.md
  // - src/packages/server/conat/socketio/README.md
  // This creates/reuses a direct browser->project-host Conat client and
  // supplies short-lived host-scoped bearer tokens via socket.io auth.
  private getOrCreateRoutedHubClient = ({
    host_id,
    address,
    host_session_id,
    project_id,
    project_ids,
  }: {
    host_id: string;
    address: string;
    host_session_id?: string;
    project_id?: string;
    project_ids?: Iterable<string>;
  }): ReturnType<typeof connectToConat> => {
    const current = this.routedHubClients[host_id];
    if (
      current &&
      current.address === address &&
      current.host_session_id === host_session_id
    ) {
      this.registerTrackedProjectForHost(host_id, current, project_id);
      if (project_ids) {
        for (const id of project_ids) {
          this.registerTrackedProjectForHost(host_id, current, id);
        }
      }
      return current.client;
    }
    if (current) {
      this.removeRoutedHubClient(host_id);
    }
    const reconnectRouted = () => {
      if (this.permanentlyDisconnected) {
        return;
      }
      if (state.reconnectTimer != null) {
        return;
      }
      const delays = [1_000, 3_500, 10_000];
      const delayMs =
        delays[Math.min(state.reconnectAttempts, delays.length - 1)];
      state.reconnectAttempts += 1;
      console.log(`scheduled routed host reconnect for ${host_id}`, {
        host_id,
        delayMs,
        reconnectAttempts: state.reconnectAttempts,
        host_session_id: state.host_session_id,
      });
      state.reconnectTimer = setTimeout(async () => {
        delete state.reconnectTimer;
        if (this.permanentlyDisconnected) {
          return;
        }
        console.log(`running routed host reconnect for ${host_id}`, {
          host_id,
          reconnectAttempts: state.reconnectAttempts,
          ...this.reconnectDebugContext(),
        });
        try {
          await waitForOnline();
        } catch {
          console.warn(
            `routed host reconnect for ${host_id} aborted while waiting for browser online`,
          );
          reconnectRouted();
          return;
        }
        if (this.routedHubClients[host_id]?.client !== state.client) {
          return;
        }
        console.log(`browser is online for routed host reconnect ${host_id}`, {
          host_id,
          reconnectAttempts: state.reconnectAttempts,
        });
        let refreshed:
          | { host_id: string; address: string; host_session_id?: string }
          | undefined;
        try {
          refreshed = await this.refreshHostRoutingInfo(host_id);
        } catch (err) {
          console.warn(
            `failed refreshing routed host info for host ${host_id}; will retry`,
            err,
          );
          reconnectRouted();
          return;
        }
        if (this.permanentlyDisconnected) {
          return;
        }
        if (this.routedHubClients[host_id]?.client !== state.client) {
          return;
        }
        if (
          refreshed &&
          (refreshed.address !== state.address ||
            refreshed.host_session_id !== state.host_session_id)
        ) {
          this.invalidateProjectHostToken(host_id, {
            resetFailureState: true,
          });
          this.removeRoutedHubClient(host_id, { expectedClient: state.client });
          this.getOrCreateRoutedHubClient({
            ...refreshed,
            project_id,
            project_ids: state.project_ids,
          });
          // Long-lived terminal/file sockets are attached to the main browser
          // client and only rebuild when that client reconnects. Trigger that
          // rebuild when the routed host endpoint/session changed.
          this.scheduleRoutedHostRecovery();
          return;
        }
        if (state.reconnectAttempts >= ROUTED_HOST_REBUILD_AFTER_ATTEMPTS) {
          this.invalidateProjectHostToken(host_id);
          this.removeRoutedHubClient(host_id, { expectedClient: state.client });
          this.getOrCreateRoutedHubClient({
            host_id,
            address: refreshed?.address ?? state.address,
            host_session_id:
              refreshed?.host_session_id ?? state.host_session_id,
            project_id,
            project_ids: state.project_ids,
          });
          return;
        }
        if (state.client.conn?.connected) {
          return;
        }
        await connectRoutedWithFreshToken();
      }, delayMs);
    };
    const state: RoutedHubClientState = {
      address,
      host_session_id,
      project_ids: new Set<string>(),
      reconnectAttempts: 0,
      client: connectToConat({
        address,
        inboxPrefix: inboxPrefix({ account_id: this.client.account_id }),
        autoConnect: false,
        auth: (cb) => {
          const authProjectId = this.pickTrackedProjectForHost(
            host_id,
            state,
            project_id,
          );
          void this.getProjectHostToken({
            host_id,
            project_id: authProjectId,
          })
            .then((token) => {
              cb({ bearer: token });
            })
            .catch((err) => {
              this.invalidateProjectHostToken(host_id);
              reconnectRouted();
              if (!this.isProjectHostAuthBackoffError(err)) {
                console.warn(
                  `failed issuing project-host auth token for host ${host_id}`,
                  err,
                );
              }
              cb({});
            });
        },
        reconnection: false,
        forceNew: true,
      }),
    };
    const connectRoutedWithFreshToken = async (): Promise<boolean> => {
      if (state.connectInFlight) {
        return await state.connectInFlight;
      }
      const connectAttempt = (async (): Promise<boolean> => {
        if (this.permanentlyDisconnected) {
          return false;
        }
        if (this.routedHubClients[host_id]?.client !== state.client) {
          return false;
        }
        if (state.client.conn?.connected) {
          return true;
        }
        const authProjectId = this.pickTrackedProjectForHost(
          host_id,
          state,
          project_id,
        );
        try {
          await this.getProjectHostToken({
            host_id,
            project_id: authProjectId,
          });
        } catch (err) {
          this.invalidateProjectHostToken(host_id);
          if (!this.isProjectHostAuthBackoffError(err)) {
            console.warn(
              `failed preparing project-host auth token for host ${host_id}`,
              err,
            );
          }
          reconnectRouted();
          return false;
        }
        if (this.permanentlyDisconnected) {
          return false;
        }
        if (this.routedHubClients[host_id]?.client !== state.client) {
          return false;
        }
        if (state.client.conn?.connected) {
          return true;
        }
        try {
          console.log(`calling connect() on routed host client ${host_id}`, {
            host_id,
            reconnectAttempts: state.reconnectAttempts,
            address: state.address,
            host_session_id: state.host_session_id,
          });
          const socket: any = state.client.conn;
          if (typeof socket?.connect === "function") {
            socket.connect();
          } else {
            state.client.connect();
          }
          return true;
        } catch (err) {
          console.warn(
            `failed reconnecting routed hub client for host ${host_id}`,
            err,
          );
          reconnectRouted();
          return false;
        }
      })().finally(() => {
        if (state.connectInFlight === connectAttempt) {
          delete state.connectInFlight;
        }
      });
      state.connectInFlight = connectAttempt;
      return await connectAttempt;
    };
    state.client.on("connected", () => {
      console.log(`routed host connected ${host_id}`, {
        host_id,
        address: state.address,
        host_session_id: state.host_session_id,
      });
      state.reconnectAttempts = 0;
      if (state.reconnectTimer != null) {
        clearTimeout(state.reconnectTimer);
        delete state.reconnectTimer;
      }
    });
    state.client.on("disconnected", () => {
      console.warn(`routed host disconnected ${host_id}`, {
        host_id,
        address: state.address,
        host_session_id: state.host_session_id,
      });
      this.invalidateProjectHostToken(host_id);
      reconnectRouted();
    });
    state.client.conn.on("connect_error", (_err) => {
      console.warn(`routed host connect_error ${host_id}`, {
        host_id,
        address: state.address,
        host_session_id: state.host_session_id,
      });
      this.invalidateProjectHostToken(host_id);
      reconnectRouted();
    });
    this.registerTrackedProjectForHost(host_id, state, project_id);
    if (project_ids) {
      for (const id of project_ids) {
        this.registerTrackedProjectForHost(host_id, state, id);
      }
    }
    this.routedHubClients[host_id] = state;
    void connectRoutedWithFreshToken();
    return state.client;
  };

  private permanentlyDisconnected = false;
  permanentlyDisconnect = () => {
    this.permanentlyDisconnected = true;
    this.standby();
  };

  is_signed_in = (): boolean => {
    return !!this._conatClient?.info?.user?.account_id;
  };

  is_connected = (): boolean => {
    return !!this._conatClient?.conn?.connected;
  };

  private startStatsReporter = async () => {
    while (true) {
      if (this._conatClient != null) {
        this.setConnectionStatus({ stats: this._conatClient?.stats });
      }
      await delay(5000);
    }
  };

  private initConatClient = async () => {
    await this.bootstrapControlPlaneOrigin();
    if (!this.remote) {
      // only initialize if not making a remote connection, since this is
      // the default connection to our local server
      setConatClient({
        account_id: this.client.account_id,
        conat: this.conat,
        reconnect: async () => this.reconnect(),
        getLogger: DEBUG
          ? (name) => {
              return {
                info: (...args) => console.info(name, ...args),
                debug: (...args) => console.log(name, ...args),
                warn: (...args) => console.warn(name, ...args),
                error: (...args) => console.error(name, ...args),
                silly: (...args) => console.log(name, ...args),
              };
            }
          : undefined,
      });
    }
    this.clientWithState = getClientWithState();
    this.clientWithState.on("state", (state) => {
      if (state != "closed") {
        this.emit(state);
      }
    });
    initTime();
    const client = this.conat();
    client.inboxPrefixHook = (info) => {
      return info?.user ? inboxPrefix(info?.user) : undefined;
    };

    client.on("info", (info) => {
      if (client.info?.user?.account_id) {
        console.log("Connected as ", JSON.stringify(client.info?.user));
        this.signedIn({
          account_id: info.user.account_id,
          hub: info.id ?? "",
        });
        void this.browserSessionAutomation
          .start(info.user.account_id)
          .catch((err) =>
            console.warn(`failed to start browser session automation: ${err}`),
          );
        const cookie = Cookies.get(ACCOUNT_ID_COOKIE);
        if (!lite && cookie && cookie != client.info.user.account_id) {
          // make sure account_id cookie is set to the actual account we're
          // signed in as, then refresh since some things are going to be
          // broken otherwise. To test this use dev tools and just change the account_id
          // cookies value to something random.
          Cookies.set(ACCOUNT_ID_COOKIE, client.info.user.account_id);
          // and we're out of here:
          const wait = 5000;
          console.log(`COOKIE ISSUE -- RELOAD IN ${wait / 1000} SECONDS...`, {
            cookie,
          });
          setTimeout(() => {
            if (lite) {
              return;
            }
            location.reload();
          }, 5000);
        }
      } else if (lite && client.info?.user?.project_id) {
        // we *also* sign in as the PROJECT in lite mode.
        console.log("lite: created project client");
      } else {
        console.log("Sign in failed -- ", client.info);
        this.signInFailed(client.info?.user?.error ?? "Failed to sign in.");
        void this.browserSessionAutomation.stop();
        if (!this.isAuthPage()) {
          this.client.alert_message({
            type: "error",
            message: "You must sign in.",
            block: true,
          });
        }
        this.standby();
      }
    });
  };

  public signedInMessage?: { account_id: string; hub: string };
  private signedIn = (mesg: { account_id: string; hub: string }) => {
    this.signedInMessage = mesg;
    this.client.account_id = mesg.account_id;
    setStoredControlPlaneOrigin(this.address);
    setRememberMe(appBasePath);
    this.client.emit("signed_in", mesg);
  };

  private signInFailed = (error) => {
    clearStoredControlPlaneOrigin();
    deleteRememberMe(appBasePath);
    this.client.emit("remember_me_failed", { error });
  };

  private isAuthPage = (): boolean => {
    if (typeof window === "undefined") {
      return false;
    }
    const base = appBasePath === "/" ? "" : appBasePath;
    return window.location.pathname.startsWith(`${base}/auth`);
  };

  reconnect = () => {
    if (this.permanentlyDisconnected) {
      return;
    }
    console.warn("manual reconnect requested", this.reconnectDebugContext());
    this.reconnectCoordinator.prepareForTransportRestart();
    void this.browserSessionAutomation.stop();
    if (this.routedHostRecoveryTimer != null) {
      clearTimeout(this.routedHostRecoveryTimer);
      delete this.routedHostRecoveryTimer;
    }
    for (const host_id in this.routedHubClients) {
      try {
        this.routedHubClients[host_id]?.client?.close();
      } catch (err) {
        console.warn(
          `failed closing routed hub client for host ${host_id}`,
          err,
        );
      }
    }
    this.routedHubClients = {};
    this.projectHostTokens = {};
    try {
      this._conatClient?.disconnect();
    } catch {}
    try {
      this._conatClient?.conn?.io?.engine?.close();
    } catch {}
    this.automaticallyReconnect = true;
    this.reconnectCoordinator.requestReconnect({
      reason: "manual_reconnect",
      priority: "foreground",
      resetBackoff: true,
    });
  };

  requestReconnect = ({
    reason = "coordinated_reconnect",
    priority = this.tabReconnectPriority(),
    resetBackoff = false,
  }: {
    reason?: string;
    priority?: ReconnectPriority;
    resetBackoff?: boolean;
  } = {}) => {
    if (this.permanentlyDisconnected) {
      return;
    }
    console.log("requestReconnect", {
      reason,
      priority,
      resetBackoff,
      ...this.reconnectDebugContext(),
    });
    this.automaticallyReconnect = true;
    this.reconnectCoordinator.requestReconnect({
      reason,
      priority,
      resetBackoff,
    });
  };

  registerReconnectResource = (
    options: ReconnectResourceOptions,
  ): RegisteredReconnectResource => {
    return this.reconnectCoordinator.registerResource(options);
  };

  private shedProjectConnections = ({
    clearTokens = false,
  }: {
    clearTokens?: boolean;
  } = {}) => {
    if (this.routedHostRecoveryTimer != null) {
      clearTimeout(this.routedHostRecoveryTimer);
      delete this.routedHostRecoveryTimer;
    }
    for (const host_id of Object.keys(this.routedHubClients)) {
      this.removeRoutedHubClient(host_id);
    }
    this.routedHubClients = {};
    if (clearTokens) {
      this.projectHostTokens = {};
    }
    disconnect_from_all_projects();
  };

  softStandby = () => {
    this.reconnectCoordinator.softStandby();
    this.shedProjectConnections();
  };

  // if there is a connection, put it in standby
  standby = () => {
    // @ts-ignore
    this.automaticallyReconnect = false;
    this.reconnectCoordinator.standby();
    void this.browserSessionAutomation.stop();
    this.shedProjectConnections({ clearTokens: true });
    this._conatClient?.disconnect();
  };

  // if there is a connection, resume it
  resume = () => {
    this.automaticallyReconnect = true;
    this.reconnectCoordinator.resume();
  };

  // keep trying until connected.
  connect = reuseInFlight(async () => {
    if (this.permanentlyDisconnected) {
      console.log(
        "Not connecting -- client is permanently disconnected and must refresh their browser",
      );
      return;
    }
    await this.bootstrapControlPlaneOrigin();
    if (this._conatClient == null) {
      this.conat();
    }
    if (this._conatClient?.conn?.connected) {
      return;
    }
    await waitForOnline();
    if (this.permanentlyDisconnected || this._conatClient?.conn?.connected) {
      return;
    }
    console.log(
      `Connecting to ${this.address}: attempt ${Math.max(this.numConnectionAttempts, 1)}`,
    );
    this.client.emit("connecting");
    this._conatClient?.connect();
  });

  callConatService: CallConatServiceFunction = async (options) => {
    return await callConatService({
      ...options,
      client: this.conat(),
    });
  };

  createConatService: CreateConatServiceFunction = (options) => {
    return createConatService({
      ...options,
      client: this.conat(),
    });
  };

  projectWebsocketApi = async ({
    project_id,
    mesg,
    timeout = DEFAULT_TIMEOUT,
  }) => {
    const cn = this.conat();
    const subject = projectSubject({
      project_id,
      service: "browser-api",
    });
    const resp = await cn.request(subject, mesg, {
      timeout,
      waitForInterest: true,
    });
    return resp.data;
  };

  private callHub = async ({
    service = "api",
    name,
    args = [],
    project_id,
    timeout = DEFAULT_TIMEOUT,
  }: {
    service?: string;
    name: string;
    args: any[];
    project_id?: string;
    timeout?: number;
  }) => {
    const subject = `hub.account.${this.client.account_id}.${service}`;
    const routeToProjectHost =
      !!project_id &&
      PROJECT_HOST_ROUTED_HUB_METHODS.has(name) &&
      isValidUUID(project_id);
    let cn = this.conat();
    if (routeToProjectHost) {
      const routing = await this.ensureProjectRoutingInfo(project_id!);
      const allowHubFallback =
        PROJECT_HOST_ROUTED_HUB_METHODS_WITH_HUB_FALLBACK.has(name) ||
        (lite &&
          PROJECT_HOST_ROUTED_HUB_METHODS_WITH_LITE_HUB_FALLBACK.has(name));
      if (!routing && !allowHubFallback) {
        throw Error(
          `unable to route '${name}' to project-host for project ${project_id}; host routing info unavailable (open the project first so host info is loaded)`,
        );
      }
      if (routing) {
        cn = this.getOrCreateRoutedHubClient({ ...routing, project_id });
      }
    }
    try {
      const data = { name, args };
      const resp = await cn.request(subject, data, { timeout });
      return resp.data;
    } catch (err) {
      if (routeToProjectHost && project_id) {
        const routing = await this.ensureProjectRoutingInfo(project_id);
        if (routing && this.isProjectHostAuthError(err)) {
          this.invalidateProjectHostToken(routing.host_id);
          this.removeRoutedHubClient(routing.host_id);
          try {
            const retryClient = this.getOrCreateRoutedHubClient({
              ...routing,
              project_id,
            });
            const retryResp = await retryClient.request(
              subject,
              { name, args },
              { timeout },
            );
            return retryResp.data;
          } catch (retryErr) {
            err = retryErr;
          }
        }
      }
      if (!routeToProjectHost && this.isTimeoutLikeError(err)) {
        this.maybeProbeStaleHubTransport(`callHub:${name}`, err);
      }
      try {
        err.message = `${err.message} - callHub: subject='${subject}', name='${name}', code='${err.code}'`;
      } catch {
        err = new Error(
          `${err.message} - callHub: subject='${subject}', name='${name}', code='${err.code}'`,
        );
      }
      throw err;
    }
  };

  // Debug helper for manually validating project-host subject ACL from browser devtools.
  // Example:
  //   await cc.conat._testPublishToProjectHost({
  //     project_id: "<project-id>",
  //     subject: "hub.account.<account-id>.api",
  //     mesg: { ping: 1 },
  //   });
  _testPublishToProjectHost = async ({
    project_id,
    subject,
    mesg = { test: true, ts: Date.now() },
    timeout = DEFAULT_TIMEOUT,
    waitForInterest = false,
  }: {
    project_id: string;
    subject: string;
    mesg?: any;
    timeout?: number;
    waitForInterest?: boolean;
  }): Promise<{
    ok: boolean;
    host_id?: string;
    address?: string;
    subject: string;
    bytes?: number;
    count?: number;
    error?: string;
    code?: string | number;
  }> => {
    if (!isValidUUID(project_id)) {
      throw Error(`project_id='${project_id}' must be a valid uuid`);
    }
    const routing = this.getProjectRoutingInfo(project_id);
    if (!routing) {
      throw Error(
        `unable to route publish to project-host for project ${project_id}; host routing info unavailable`,
      );
    }
    const cn = this.getOrCreateRoutedHubClient({ ...routing, project_id });
    try {
      const { bytes, count } = await cn.publish(subject, mesg, {
        timeout,
        waitForInterest,
      });
      return {
        ok: true,
        host_id: routing.host_id,
        address: routing.address,
        subject,
        bytes,
        count,
      };
    } catch (err: any) {
      if (this.isProjectHostAuthError(err)) {
        this.invalidateProjectHostToken(routing.host_id);
        this.removeRoutedHubClient(routing.host_id);
      }
      return {
        ok: false,
        host_id: routing.host_id,
        address: routing.address,
        subject,
        error: `${err?.message ?? err}`,
        code: err?.code,
      };
    }
  };

  // Returns api for RPC calls to the project with typescript support!
  projectApi = ({
    project_id,
    timeout = DEFAULT_TIMEOUT,
  }: {
    project_id: string;
    // IMPORTANT: this timeout is only AFTER user is connected.
    timeout?: number;
  }): ProjectApi => {
    if (!isValidUUID(project_id)) {
      throw Error(`project_id = '${project_id}' must be a valid uuid`);
    }
    return projectApiClient({
      project_id,
      timeout,
      client: this.conat(),
    });
  };

  // Convenience wrapper for hub.agent.* so callers don't need to go
  // through hub namespaces directly.
  agent = {
    manifest: async (opts?: {
      timeoutMs?: number;
    }): Promise<AgentManifestEntry[]> => {
      const response = await this.callHub({
        name: "agent.manifest",
        args: [{}],
        timeout: opts?.timeoutMs ?? AGENT_MANIFEST_TIMEOUT,
      });
      return handleErrorMessage(response);
    },
    plan: async (
      opts: Omit<AgentPlanRequest, "account_id">,
    ): Promise<AgentPlanResponse> => {
      const { timeoutMs, ...planOpts } = opts as Omit<
        AgentPlanRequest,
        "account_id"
      > & { timeoutMs?: number };
      const response = await this.callHub({
        name: "agent.plan",
        args: [{ ...planOpts, account_id: this.client.account_id }],
        timeout: timeoutMs ?? AGENT_PLAN_TIMEOUT,
      });
      return handleErrorMessage(response);
    },
    execute: async (
      opts: Omit<AgentExecuteRequest, "account_id">,
    ): Promise<AgentExecuteResponse> => {
      const { timeoutMs, ...executeOpts } = opts as Omit<
        AgentExecuteRequest,
        "account_id"
      > & { timeoutMs?: number };
      const response = await this.callHub({
        name: "agent.execute",
        args: [{ ...executeOpts, account_id: this.client.account_id }],
        timeout: timeoutMs ?? AGENT_EXECUTE_TIMEOUT,
      });
      return handleErrorMessage(response);
    },
    run: async (
      opts: Omit<AgentRunRequest, "account_id">,
    ): Promise<AgentRunResponse> => {
      const { timeoutMs, ...runOpts } = opts as Omit<
        AgentRunRequest,
        "account_id"
      > & { timeoutMs?: number };
      const response = await this.callHub({
        name: "agent.run",
        args: [{ ...runOpts, account_id: this.client.account_id }],
        timeout: timeoutMs ?? AGENT_RUN_TIMEOUT,
      });
      return handleErrorMessage(response);
    },
  };

  synctable: ConatSyncTableFunction = async (
    query0,
    options?,
  ): Promise<ConatSyncTable> => {
    const { query } = parseQueryWithOptions(query0, options);
    return await this.conat().sync.synctable({
      ...options,
      query,
      account_id: this.client.account_id,
    });
  };

  primus = ({
    project_id,
    channel,
  }: {
    project_id: string;
    channel?: string;
  }) => {
    let subject = projectSubject({
      project_id,
      service: "primus",
    });
    if (channel) {
      subject += "." + channel;
    }
    return this.conat().socket.connect(subject, {
      desc: `primus-${channel ?? ""}`,
    });
  };

  pubsub = async ({
    project_id,
    path,
    name,
  }: {
    project_id: string;
    path?: string;
    name: string;
  }) => {
    return new PubSub({ client: this.conat(), project_id, path, name });
  };

  // Evaluate an llm.  This streams the result if stream is given an option,
  // AND it also always returns the result.
  llm = async (opts: ChatOptions): Promise<string> => {
    return await requestLlm(
      { account_id: this.client.account_id, ...opts },
      this.conat(),
    );
  };

  streamAcp = async (request, options?) => {
    return await acp.streamAcp(
      { ...request, account_id: this.client.account_id },
      options,
      this.conat(),
    );
  };

  runAcp = async (request, options?) => {
    return await acp.runAcp(
      { account_id: this.client.account_id, ...request },
      options,
      this.conat(),
    );
  };

  interruptAcp = async (request) => {
    await acp.interruptAcp(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  steerAcp = async (request) => {
    return await acp.steerAcp(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  forkAcpSession = async (request) => {
    return await acp.forkAcpSession(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  truncateAcpSession = async (request) => {
    return await acp.truncateAcpSession(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  controlAcp = async (request) => {
    return await acp.controlAcp(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  automationAcp = async (request) => {
    return await acp.automationAcp(
      { account_id: this.client.account_id, ...request },
      this.conat(),
    );
  };

  dstream = async <T>(opts: DStreamOptions) => {
    return await dstream<T>({ ...opts, client: this.conat() });
  };

  astream = <T>(opts: DStreamOptions) => {
    return astream<T>({ ...opts, client: this.conat() });
  };
  // NOTE: this higher-level frontend wrapper exposes sync primitives directly,
  // e.g. `webapp_client.conat_client.dkv(...)`. Shared helpers in packages that
  // also run in backend/CLI should not assume this object is the low-level core
  // client from `@cocalc/conat/core/client`, which instead exposes these under
  // `client.sync.*` and is returned by `conat()`.
  dkv = async <T>(opts: DKVOptions) => {
    return await dkv<T>({ ...opts, client: opts.client ?? this.conat() });
  };

  akv = <T>(opts: DKVOptions) => {
    return akv<T>({ ...opts, client: opts.client ?? this.conat() });
  };

  dko = async <T>(opts: DKVOptions) => {
    return await dko<T>({ ...opts, client: opts.client ?? this.conat() });
  };

  listings = async (opts: { project_id: string }) => {
    return await listingsClient({
      project_id: opts.project_id,
      client: this.conat(),
    });
  };

  getTime = (): number => {
    return getTime();
  };

  getSkew = async (): Promise<number> => {
    return await getSkew();
  };

  inventory = async (location: {
    account_id?: string;
    project_id?: string;
  }) => {
    const inv = await inventory({ ...location, client: this.conat() });
    // @ts-ignore
    if (console.log_original != null) {
      const ls_orig = inv.ls;
      // @ts-ignore
      inv.ls = (opts) => ls_orig({ ...opts, log: console.log_original });
    }
    return inv;
  };

  refCacheInfo = () => refCacheInfo();

  lroStream = (opts: {
    op_id?: string;
    stream_name?: string;
    scope_type: LroScopeType;
    scope_id?: string;
  }) => {
    return getLroStream({ client: this.conat(), ...opts });
  };

  lroWait = (opts: {
    op_id?: string;
    stream_name?: string;
    scope_type: LroScopeType;
    scope_id?: string;
    timeout_ms?: number;
    onProgress?: (event: Extract<LroEvent, { type: "progress" }>) => void;
    onSummary?: (summary: LroSummary) => void;
  }) => {
    return waitForLroCompletion({ client: this.conat(), ...opts });
  };

  terminalClient = (opts: {
    project_id: string;
    getSize?: () => undefined | { rows: number; cols: number };
    reconnection?: boolean;
  }) => {
    return terminalClient({
      client: this.conat(),
      ...opts,
    });
  };
}

async function waitForOnline(): Promise<void> {
  if (typeof navigator === "undefined" || navigator.onLine !== false) return;
  await new Promise<void>((resolve) => {
    const handler = () => {
      window.removeEventListener("online", handler);
      resolve();
    };
    window.addEventListener("online", handler);
  });
}
