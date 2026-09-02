import callHub from "@cocalc/conat/hub/call-hub";
import type {
  ProjectBandwidthRelayEvidence,
  ProjectCryptominingEvidence,
} from "@cocalc/conat/hub/api/system";
import { hubApi } from "@cocalc/lite/hub/api";
import { getMasterConatClient } from "../master-status";

function requireMasterClient(name: string) {
  const client = getMasterConatClient();
  if (!client) {
    throw new Error(`master hub connection unavailable for '${name}'`);
  }
  return client;
}

function defaultHostScope(): { host_id?: string } {
  const host_id = `${process.env.PROJECT_HOST_ID ?? ""}`.trim();
  return host_id ? { host_id } : {};
}

async function forwardSystem(
  name: string,
  args: any[],
  scope = defaultHostScope(),
) {
  return await callHub({
    client: requireMasterClient(name),
    name,
    args,
    ...(scope?.host_id ? { host_id: scope.host_id } : {}),
  });
}

export function wireSystemApi(): void {
  hubApi.system.ping = () => ({ now: Date.now() });

  hubApi.system.getProjectHostParallelOpsLimit = async (opts?: {
    account_id?: string;
    host_id?: string;
    worker_kind: string;
  }) => {
    return await forwardSystem("system.getProjectHostParallelOpsLimit", [opts]);
  };

  hubApi.system.getManagedProjectEgressPolicy = async (opts?: {
    account_id?: string;
    project_id?: string;
    category?:
      | "file-download"
      | "http-proxy"
      | "ws-proxy"
      | "ssh"
      | "interactive-conat"
      | "control-plane-conat"
      | "raw-network"
      | "backup-upload";
  }) => {
    return await forwardSystem("system.getManagedProjectEgressPolicy", [opts]);
  };

  hubApi.system.recordManagedProjectEgress = async (opts: {
    account_id?: string;
    project_id?: string;
    category:
      | "file-download"
      | "http-proxy"
      | "ws-proxy"
      | "ssh"
      | "interactive-conat"
      | "control-plane-conat"
      | "raw-network"
      | "backup-upload";
    bytes: number;
    bandwidth_relay_evidence?: ProjectBandwidthRelayEvidence;
    metadata?: Record<string, unknown>;
  }) => {
    return await forwardSystem("system.recordManagedProjectEgress", [opts]);
  };

  hubApi.system.recordManagedProjectCpuUsage = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id?: string;
    cpu_seconds: number;
    sample_started_at?: Date;
    sample_ended_at?: Date;
    source?: string;
    cryptomining_evidence?: ProjectCryptominingEvidence;
    metadata?: Record<string, unknown>;
  }) => {
    return await forwardSystem("system.recordManagedProjectCpuUsage", [opts]);
  };

  hubApi.system.resolveManagedProjectSshKeyAccount = async (opts: {
    project_id: string;
    fingerprint: string;
  }) => {
    return await forwardSystem("system.resolveManagedProjectSshKeyAccount", [
      opts,
    ]);
  };

  hubApi.system.getServiceAdmissionConfig = async () => {
    return await forwardSystem("system.getServiceAdmissionConfig", []);
  };

  hubApi.system.getCustomize = async (fields?: string[]) => {
    return await forwardSystem("system.getCustomize", [fields]);
  };

  hubApi.system.getPublicSiteUrl = async (opts?: {
    account_id?: string;
    project_id?: string;
    host_id?: string;
  }) => {
    return await forwardSystem("system.getPublicSiteUrl", [opts]);
  };

  hubApi.system.tracePrivateAppHostname = async (opts: {
    account_id?: string;
    host_id?: string;
    hostname: string;
  }) => {
    return await forwardSystem("system.tracePrivateAppHostname", [opts]);
  };

  hubApi.system.getProjectAppPrivateHostnamePolicy = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id: string;
  }) => {
    return await forwardSystem("system.getProjectAppPrivateHostnamePolicy", [
      opts,
    ]);
  };

  hubApi.system.inspectProjectAppPrivateHostname = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id: string;
    app_id: string;
  }) => {
    return await forwardSystem("system.inspectProjectAppPrivateHostname", [
      opts,
    ]);
  };

  hubApi.system.listProjectAppPrivateHostnames = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id: string;
  }) => {
    return await forwardSystem("system.listProjectAppPrivateHostnames", [opts]);
  };

  hubApi.system.reserveProjectAppPrivateHostname = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id: string;
    app_id: string;
  }) => {
    return await forwardSystem("system.reserveProjectAppPrivateHostname", [
      opts,
    ]);
  };

  hubApi.system.releaseProjectAppPrivateHostname = async (opts: {
    account_id?: string;
    host_id?: string;
    project_id: string;
    app_id: string;
  }) => {
    return await forwardSystem("system.releaseProjectAppPrivateHostname", [
      opts,
    ]);
  };

  hubApi.hosts.getManagedRootfsReleaseArtifact = async (opts: {
    host_id?: string;
    image: string;
  }) => {
    const scope = defaultHostScope();
    return await callHub({
      client: requireMasterClient("hosts.getManagedRootfsReleaseArtifact"),
      name: "hosts.getManagedRootfsReleaseArtifact",
      args: [opts],
      ...(scope?.host_id ? { host_id: scope.host_id } : {}),
    });
  };

  hubApi.hosts.recordManagedRootfsReleaseReplica = async (opts: {
    host_id?: string;
    image: string;
    upload: {
      ok: true;
      backend: "rustic";
      artifact_kind?: "full";
      artifact_format: "rustic";
      artifact_backend: "r2" | "rest";
      artifact_sha256: string;
      artifact_bytes: number;
      artifact_path: string;
      snapshot_id: string;
      repo_selector: string;
      repo_id?: string;
      repo_root?: string;
      region?: string;
      bucket_id?: string;
      bucket_name?: string;
      bucket_purpose?: string | null;
      phase_timings_ms?: Record<string, number>;
    };
  }) => {
    const scope = defaultHostScope();
    return await callHub({
      client: requireMasterClient("hosts.recordManagedRootfsReleaseReplica"),
      name: "hosts.recordManagedRootfsReleaseReplica",
      args: [opts],
      ...(scope?.host_id ? { host_id: scope.host_id } : {}),
    });
  };

  hubApi.hosts.listManagedRootfsReleaseLifecycle = async (opts: {
    host_id?: string;
    images: string[];
  }) => {
    const scope = defaultHostScope();
    return await callHub({
      client: requireMasterClient("hosts.listManagedRootfsReleaseLifecycle"),
      name: "hosts.listManagedRootfsReleaseLifecycle",
      args: [opts],
      ...(scope?.host_id ? { host_id: scope.host_id } : {}),
    });
  };
}
