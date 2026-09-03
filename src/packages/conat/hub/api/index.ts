import { isValidUUID } from "@cocalc/util/misc";
import { type Purchases, purchases } from "./purchases";
import { type System, system } from "./system";
import { type Projects, projects } from "./projects";
import { type DB, db } from "./db";
import { handleErrorMessage } from "@cocalc/conat/util";
import { type Sync, sync } from "./sync";
import { type Org, org } from "./org";
import { type Messages, messages } from "./messages";
import { type Hosts, hosts } from "./hosts";
import { type Software, software } from "./software";
import { type LroApi, lro } from "./lro";
import { type Ssh, ssh } from "./ssh";
import { type ReflectApi, reflect } from "./reflect";
import { type AgentApi, agent } from "./agent";
import { type Notifications, notifications } from "./notifications";
import { type AdminData, adminData } from "./admin-data-explorer";
import { type AdminDbApi, adminDb } from "./admin-db";
import { type AdminHostApi, adminHost } from "./admin-host";
import { type AdminSupportApi, adminSupport } from "./admin-support";
import { type AdminCrashesApi, adminCrashes } from "./admin-crashes";
import { type AiSessionsApi, aiSessions } from "./ai-sessions";
import { type LegacyMigration, legacyMigration } from "./legacy-migration";
import { type ComputeApi, compute } from "./compute";
import {
  type PublicDirectoryShares,
  publicDirectoryShares,
} from "./public-directory-shares";
import { type GrowthAnalyticsApi, growthAnalytics } from "./growth-analytics";
import {
  type CommercialOrdersApi,
  commercialOrders,
} from "./commercial-orders";
import { type AdminCrmApi, adminCrm } from "./crm";
import type { HubApiArgTransform, HubApiPrincipalPolicy } from "./util";

export interface HubApi {
  system: System;
  projects: Projects;
  db: DB;
  purchases: Purchases;
  sync: Sync;
  org: Org;
  messages: Messages;
  hosts: Hosts;
  software: Software;
  lro: LroApi;
  ssh: Ssh;
  reflect: ReflectApi;
  agent: AgentApi;
  notifications: Notifications;
  adminData: AdminData;
  adminDb: AdminDbApi;
  adminHost: AdminHostApi;
  adminSupport: AdminSupportApi;
  adminCrashes: AdminCrashesApi;
  aiSessions: AiSessionsApi;
  legacyMigration: LegacyMigration;
  compute: ComputeApi;
  publicDirectoryShares: PublicDirectoryShares;
  growthAnalytics: GrowthAnalyticsApi;
  commercialOrders: CommercialOrdersApi;
  adminCrm: AdminCrmApi;
}

type HubApiTransformStructure = {
  [Group in keyof HubApi]: {
    [Method in keyof HubApi[Group]]: HubApiArgTransform;
  };
};

const HubApiStructure = {
  system,
  projects,
  db,
  purchases,
  sync,
  org,
  messages,
  hosts,
  software,
  lro,
  ssh,
  reflect,
  agent,
  notifications,
  adminData,
  adminDb,
  adminHost,
  adminSupport,
  adminCrashes,
  aiSessions,
  legacyMigration,
  compute,
  publicDirectoryShares,
  growthAnalytics,
  commercialOrders,
  adminCrm,
} as const satisfies HubApiTransformStructure;

export function getHubApiPrincipalPolicy(
  name: string,
): HubApiPrincipalPolicy | undefined {
  const [group, functionName] = `${name ?? ""}`.split(".");
  return HubApiStructure[group]?.[functionName]?.principalPolicy;
}

export function getHubApiPrincipalPolicies(): Record<
  string,
  HubApiPrincipalPolicy
> {
  const policies: Record<string, HubApiPrincipalPolicy> = {};
  for (const group in HubApiStructure) {
    for (const functionName in HubApiStructure[group]) {
      policies[`${group}.${functionName}`] =
        HubApiStructure[group][functionName].principalPolicy;
    }
  }
  return policies;
}

export function getHubApiAccountTargetMethods(): string[] {
  const methods: string[] = [];
  for (const group in HubApiStructure) {
    for (const functionName in HubApiStructure[group]) {
      if (HubApiStructure[group][functionName].preservesAccountTarget) {
        methods.push(`${group}.${functionName}`);
      }
    }
  }
  return methods.sort();
}

export function isHubApiPrincipalAllowed({
  policy,
  account_id,
  project_id,
  host_id,
  auth_actor,
}: {
  policy: HubApiPrincipalPolicy;
  account_id?: string;
  project_id?: string;
  host_id?: string;
  auth_actor?: "agent";
}): boolean {
  if (policy === "public") return true;
  if (policy === "authenticated") {
    return !!(account_id || project_id || host_id);
  }
  if (policy === "account") return !!account_id && auth_actor !== "agent";
  if (policy === "project") return !!project_id && auth_actor !== "agent";
  if (policy === "host") return !!host_id && auth_actor !== "agent";
  if (policy === "project-or-host") {
    return !!(project_id || host_id) && auth_actor !== "agent";
  }
  if (policy === "account-or-project") {
    return !!(account_id || project_id) && auth_actor !== "agent";
  }
  if (policy === "account-or-host") {
    return !!(account_id || host_id) && auth_actor !== "agent";
  }
  if (policy === "account-or-project-or-host") {
    return !!(account_id || project_id || host_id) && auth_actor !== "agent";
  }
  if (policy === "compute-project") {
    return auth_actor === "agent" || (!!(project_id || host_id) && !account_id);
  }
  if (policy === "account-or-compute-project") {
    return auth_actor === "agent" || !!(account_id || project_id || host_id);
  }
  if (policy === "account-or-compute-agent") {
    return auth_actor === "agent" || !!account_id;
  }
  if (policy === "account-or-host-or-compute-agent") {
    return auth_actor === "agent" || !!account_id || !!host_id;
  }
  return false;
}

export function transformArgs({
  name,
  args,
  account_id,
  auth_session_hash,
  project_id,
  host_id,
  auth_actor,
  auth_token_fingerprint,
  auth_iat_s,
  auth_exp_s,
}: {
  name: string;
  args: any[];
  account_id?: string;
  auth_session_hash?: string | null;
  project_id?: string;
  host_id?: string;
  auth_actor?: "agent";
  auth_token_fingerprint?: string;
  auth_iat_s?: number;
  auth_exp_s?: number;
}) {
  const [group, functionName] = name.split(".");
  return HubApiStructure[group]?.[functionName]({
    args,
    account_id,
    auth_session_hash,
    project_id,
    host_id,
    auth_actor,
    auth_token_fingerprint,
    auth_iat_s,
    auth_exp_s,
  });
}

export function initHubApi(callHubApi): HubApi {
  function extractProjectId(args: any[]): string | undefined {
    const project_id = args?.[0]?.project_id;
    if (typeof project_id === "string" && isValidUUID(project_id)) {
      return project_id;
    }
    return undefined;
  }

  const hubApi: any = {};
  for (const group in HubApiStructure) {
    if (hubApi[group] == null) {
      hubApi[group] = {};
    }
    for (const functionName in HubApiStructure[group]) {
      hubApi[group][functionName] = async (...args) => {
        const resp = await callHubApi({
          name: `${group}.${functionName}`,
          args,
          timeout: args[0]?.timeout,
          project_id: extractProjectId(args),
        });
        // A failed LRO legitimately returns its operation failure in the
        // top-level `error` field.  Do not confuse that successful API result
        // with the legacy `{ error }` RPC failure envelope.
        if (
          group === "lro" &&
          functionName === "get" &&
          resp != null &&
          typeof resp === "object" &&
          typeof resp.op_id === "string" &&
          typeof resp.scope_type === "string" &&
          typeof resp.status === "string"
        ) {
          return resp;
        }
        return handleErrorMessage(resp);
      };
    }
  }
  return hubApi as HubApi;
}

type UserId =
  | {
      account_id: string;
      project_id: undefined;
      host_id: undefined;
      auth_actor?: undefined;
      auth_token_fingerprint?: undefined;
      auth_iat_s?: undefined;
      auth_exp_s?: undefined;
    }
  | {
      account_id: undefined;
      project_id: string;
      host_id: undefined;
      auth_actor?: undefined;
      auth_token_fingerprint?: undefined;
      auth_iat_s?: undefined;
      auth_exp_s?: undefined;
    }
  | {
      account_id: undefined;
      project_id: undefined;
      host_id: string;
      auth_actor?: undefined;
      auth_token_fingerprint?: undefined;
      auth_iat_s?: undefined;
      auth_exp_s?: undefined;
    }
  | {
      account_id: string;
      project_id: string;
      host_id: undefined;
      auth_actor: "agent";
      auth_token_fingerprint: string;
      auth_iat_s?: number;
      auth_exp_s?: number;
    };

export function getUserId(subject: string): UserId {
  const segments = subject.split(".");
  if (segments[1] === "agent") {
    const account_id = segments[2];
    const project_id = segments[3];
    const auth_token_fingerprint = segments[4];
    if (
      segments.length !== 8 ||
      !isValidUUID(account_id) ||
      !isValidUUID(project_id) ||
      !/^[a-f0-9]{64}$/.test(auth_token_fingerprint) ||
      !/^\d+$/.test(segments[5] ?? "") ||
      !/^\d+$/.test(segments[6] ?? "") ||
      segments[7] !== "api"
    ) {
      throw new Error("invalid agent API subject");
    }
    return {
      account_id,
      project_id,
      host_id: undefined,
      auth_actor: "agent",
      auth_token_fingerprint,
      auth_iat_s: Number(segments[5]),
      auth_exp_s: Number(segments[6]),
    };
  }
  const uuid = segments[2];
  if (!isValidUUID(uuid)) {
    throw Error(`invalid uuid '${uuid}'`);
  }
  const type = segments[1]; // 'project' or 'account' or 'host'
  if (type == "project") {
    return { project_id: uuid } as UserId;
  } else if (type == "account") {
    return { account_id: uuid } as UserId;
  } else if (type == "host") {
    return { host_id: uuid } as UserId;
  } else {
    throw Error("must be project or account or host");
  }
}
