import type {
  Host,
  HostAccessEntry,
  HostAccessRole,
  HostFundingMode,
  HostLroResponse,
  HostSpotRecoveryPolicy,
} from "@cocalc/conat/hub/api/hosts";
import { alert_message } from "@cocalc/frontend/alerts";
import { isFreshAuthRequiredError } from "@cocalc/frontend/auth/fresh-auth";
import type { HostDrainOptions } from "../types";

const HOST_SHARED_SCRATCH_RPC_TIMEOUT_MS = 120_000;

type HubClient = {
  hosts: {
    startHost: (opts: {
      id: string;
      browser_id?: string;
    }) => Promise<HostLroResponse>;
    stopHost: (opts: {
      id: string;
      browser_id?: string;
      skip_backups?: boolean;
    }) => Promise<HostLroResponse>;
    restartHost?: (opts: {
      id: string;
      browser_id?: string;
      mode?: "reboot" | "hard";
    }) => Promise<HostLroResponse>;
    drainHost?: (opts: {
      id: string;
      browser_id?: string;
      dest_host_id?: string;
      force?: boolean;
      allow_offline?: boolean;
      parallel?: number;
    }) => Promise<HostLroResponse>;
    stopHostProjects?: (opts: {
      id: string;
      browser_id?: string;
      state_filter?: "all" | "running" | "stopped" | "unprovisioned";
      project_state?: string;
      risk_only?: boolean;
      parallel?: number;
    }) => Promise<HostLroResponse>;
    restartHostProjects?: (opts: {
      id: string;
      browser_id?: string;
      state_filter?: "all" | "running" | "stopped" | "unprovisioned";
      project_state?: string;
      risk_only?: boolean;
      parallel?: number;
    }) => Promise<HostLroResponse>;
    backupHostProjects?: (opts: {
      id: string;
      parallel?: number;
    }) => Promise<HostLroResponse>;
    deleteHost: (opts: {
      id: string;
      browser_id?: string;
      skip_backups?: boolean;
    }) => Promise<HostLroResponse>;
    forceDeprovisionHost?: (opts: {
      id: string;
      browser_id?: string;
    }) => Promise<HostLroResponse>;
    removeSelfHostConnector?: (opts: {
      id: string;
      browser_id?: string;
    }) => Promise<HostLroResponse>;
    listHostAccess?: (opts: {
      id: string;
      include_revoked?: boolean;
    }) => Promise<HostAccessEntry[]>;
    setHostAccess?: (opts: {
      id: string;
      browser_id?: string;
      target_account_id?: string;
      target_email_address?: string;
      role: HostAccessRole;
    }) => Promise<HostAccessEntry>;
    removeHostAccess?: (opts: {
      id: string;
      browser_id?: string;
      target_account_id: string;
    }) => Promise<HostAccessEntry | undefined>;
    setHostProjectRamLimit?: (opts: {
      id: string;
      browser_id?: string;
      project_ram_limit_mb?: number | null;
    }) => Promise<Host>;
    setHostOwnerSpendLimits?: (opts: {
      id: string;
      browser_id?: string;
      owner_spend_limit_5h_usd?: number | null;
      owner_spend_limit_7d_usd?: number | null;
    }) => Promise<Host>;
    setHostPoolAccess?: (opts: {
      id: string;
      browser_id?: string;
      tier?: number | null;
    }) => Promise<Host>;
    setHostDeletionProtection?: (opts: {
      id: string;
      browser_id?: string;
      enabled: boolean;
    }) => Promise<Host>;
    renameHost?: (opts: { id: string; name: string }) => Promise<unknown>;
    updateHostMachine?: (opts: {
      id: string;
      browser_id?: string;
      cloud?: string;
      cpu?: number;
      ram_gb?: number;
      disk_gb?: number;
      disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
      shared_disk_gb?: number;
      shared_disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
      delete_shared_scratch?: boolean;
      machine_type?: string;
      gpu_type?: string;
      gpu_count?: number;
      storage_mode?: "ephemeral" | "persistent";
      region?: string;
      zone?: string;
      funding_mode?: HostFundingMode;
      self_host_ssh_target?: string;
      auto_grow_enabled?: boolean;
      auto_grow_max_disk_gb?: number;
      auto_grow_growth_step_gb?: number;
      auto_grow_min_grow_interval_minutes?: number;
      shared_scratch_auto_grow_enabled?: boolean;
      shared_scratch_auto_grow_max_disk_gb?: number;
      shared_scratch_auto_grow_growth_step_gb?: number;
      shared_scratch_auto_grow_min_grow_interval_minutes?: number;
      pricing_model?: "on_demand" | "spot";
      interruption_restore_policy?: "none" | "immediate";
      spot_recovery_policy?: HostSpotRecoveryPolicy;
      timeout?: number;
    }) => Promise<unknown>;
  };
};

type UseHostActionsOptions = {
  hub: HubClient;
  setHosts: React.Dispatch<React.SetStateAction<Host[]>>;
  refresh: () => Promise<Host[]>;
  onHostOp?: (host_id: string, op: HostLroResponse) => void;
  browser_id?: string;
};

export const useHostActions = ({
  hub,
  setHosts,
  refresh,
  onHostOp,
  browser_id,
}: UseHostActionsOptions) => {
  const setStatus = async (
    id: string,
    action: "start" | "stop",
    opts?: { skip_backups?: boolean },
  ) => {
    try {
      setHosts((prev) =>
        prev.map((h) =>
          h.id === id
            ? { ...h, status: action === "start" ? "starting" : "stopping" }
            : h,
        ),
      );
      if (action === "start") {
        const op = await hub.hosts.startHost({ id, browser_id });
        onHostOp?.(id, op);
      } else {
        const op = await hub.hosts.stopHost({
          id,
          browser_id,
          skip_backups: opts?.skip_backups,
        });
        onHostOp?.(id, op);
      }
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        try {
          await refresh();
        } catch {
          // ignore refresh errors while restoring optimistic UI state
        }
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      console.error("host refresh failed", err);
    }
  };

  const restartHost = async (id: string, mode: "reboot" | "hard") => {
    if (!hub.hosts.restartHost) {
      return;
    }
    try {
      setHosts((prev) =>
        prev.map((host) =>
          host.id === id ? { ...host, status: "restarting" } : host,
        ),
      );
      const op = await hub.hosts.restartHost({ id, browser_id, mode });
      onHostOp?.(id, op);
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        try {
          await refresh();
        } catch {}
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
      return;
    }
    try {
      await refresh();
    } catch (err) {
      console.error("host refresh failed", err);
    }
  };

  const removeHost = async (id: string, opts?: { skip_backups?: boolean }) => {
    try {
      const op = await hub.hosts.deleteHost({
        id,
        browser_id,
        skip_backups: opts?.skip_backups,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const drainHost = async (id: string, opts?: HostDrainOptions) => {
    if (!hub.hosts.drainHost) {
      return;
    }
    try {
      const op = await hub.hosts.drainHost({
        id,
        browser_id,
        dest_host_id: opts?.dest_host_id,
        force: opts?.force,
        allow_offline: opts?.allow_offline,
        parallel: opts?.parallel,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const renameHost = async (id: string, name: string) => {
    const cleaned = name?.trim();
    if (!cleaned) {
      return;
    }
    try {
      if (!hub.hosts.renameHost) {
        return;
      }
      await hub.hosts.renameHost({ id, name: cleaned });
      setHosts((prev) =>
        prev.map((host) =>
          host.id === id ? { ...host, name: cleaned } : host,
        ),
      );
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const stopHostProjects = async (
    id: string,
    opts?: {
      state_filter?: "all" | "running" | "stopped" | "unprovisioned";
      project_state?: string;
      risk_only?: boolean;
      parallel?: number;
    },
  ) => {
    if (!hub.hosts.stopHostProjects) {
      return;
    }
    try {
      const op = await hub.hosts.stopHostProjects({
        id,
        browser_id,
        ...opts,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const restartHostProjects = async (
    id: string,
    opts?: {
      state_filter?: "all" | "running" | "stopped" | "unprovisioned";
      project_state?: string;
      risk_only?: boolean;
      parallel?: number;
    },
  ) => {
    if (!hub.hosts.restartHostProjects) {
      return;
    }
    try {
      const op = await hub.hosts.restartHostProjects({
        id,
        browser_id,
        ...opts,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const backupHostProjects = async (
    id: string,
    opts?: { parallel?: number },
  ) => {
    if (!hub.hosts.backupHostProjects) {
      return;
    }
    try {
      const op = await hub.hosts.backupHostProjects({
        id,
        ...opts,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const updateHostMachine = async (
    id: string,
    opts: {
      cloud?: string;
      cpu?: number;
      ram_gb?: number;
      disk_gb?: number;
      disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
      shared_disk_gb?: number;
      shared_disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
      delete_shared_scratch?: boolean;
      machine_type?: string;
      gpu_type?: string;
      gpu_count?: number;
      storage_mode?: "ephemeral" | "persistent";
      region?: string;
      zone?: string;
      self_host_ssh_target?: string;
      auto_grow_enabled?: boolean;
      auto_grow_max_disk_gb?: number;
      auto_grow_growth_step_gb?: number;
      auto_grow_min_grow_interval_minutes?: number;
      shared_scratch_auto_grow_enabled?: boolean;
      shared_scratch_auto_grow_max_disk_gb?: number;
      shared_scratch_auto_grow_growth_step_gb?: number;
      shared_scratch_auto_grow_min_grow_interval_minutes?: number;
      pricing_model?: "on_demand" | "spot";
      interruption_restore_policy?: "none" | "immediate";
      spot_recovery_policy?: HostSpotRecoveryPolicy;
    },
  ) => {
    if (!hub.hosts.updateHostMachine) {
      return;
    }
    try {
      const scratchOperation =
        opts.delete_shared_scratch ||
        opts.shared_disk_gb != null ||
        opts.shared_disk_type != null ||
        opts.shared_scratch_auto_grow_enabled != null ||
        opts.shared_scratch_auto_grow_max_disk_gb != null ||
        opts.shared_scratch_auto_grow_growth_step_gb != null ||
        opts.shared_scratch_auto_grow_min_grow_interval_minutes != null;
      await hub.hosts.updateHostMachine({
        id,
        browser_id,
        ...opts,
        ...(scratchOperation
          ? { timeout: HOST_SHARED_SCRATCH_RPC_TIMEOUT_MS }
          : undefined),
      });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error(err);
    }
  };

  const deleteSharedScratch = async (id: string) => {
    await updateHostMachine(id, { delete_shared_scratch: true });
  };

  const forceDeprovision = async (id: string) => {
    if (!hub.hosts.forceDeprovisionHost) {
      return;
    }
    try {
      const op = await hub.hosts.forceDeprovisionHost({ id, browser_id });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      console.error(err);
    }
  };

  const removeSelfHostConnector = async (id: string) => {
    if (!hub.hosts.removeSelfHostConnector) {
      return;
    }
    try {
      const op = await hub.hosts.removeSelfHostConnector({ id, browser_id });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      console.error(err);
    }
  };

  const listHostAccess = async (id: string) => {
    if (!hub.hosts.listHostAccess) {
      return [];
    }
    return await hub.hosts.listHostAccess({ id });
  };

  const setHostAccess = async (
    id: string,
    opts: {
      target_account_id?: string;
      target_email_address?: string;
      role: HostAccessRole;
    },
  ) => {
    if (!hub.hosts.setHostAccess) {
      return;
    }
    try {
      await hub.hosts.setHostAccess({ id, browser_id, ...opts });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const removeHostAccess = async (id: string, target_account_id: string) => {
    if (!hub.hosts.removeHostAccess) {
      return;
    }
    try {
      await hub.hosts.removeHostAccess({ id, browser_id, target_account_id });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const setHostProjectRamLimit = async (
    id: string,
    project_ram_limit_mb?: number | null,
  ) => {
    if (!hub.hosts.setHostProjectRamLimit) {
      return;
    }
    try {
      await hub.hosts.setHostProjectRamLimit({
        id,
        browser_id,
        project_ram_limit_mb,
      });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const setHostOwnerSpendLimits = async (
    id: string,
    opts: {
      owner_spend_limit_5h_usd?: number | null;
      owner_spend_limit_7d_usd?: number | null;
    },
  ) => {
    if (!hub.hosts.setHostOwnerSpendLimits) {
      return;
    }
    try {
      await hub.hosts.setHostOwnerSpendLimits({ id, browser_id, ...opts });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const setHostPoolAccess = async (id: string, tier?: number | null) => {
    if (!hub.hosts.setHostPoolAccess) {
      return;
    }
    try {
      await hub.hosts.setHostPoolAccess({ id, browser_id, tier });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const setHostDeletionProtection = async (id: string, enabled: boolean) => {
    if (!hub.hosts.setHostDeletionProtection) {
      return;
    }
    try {
      await hub.hosts.setHostDeletionProtection({ id, browser_id, enabled });
      await refresh();
    } catch (err) {
      if (isFreshAuthRequiredError(err)) {
        throw err;
      }
      alert_message({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  return {
    setStatus,
    restartHost,
    drainHost,
    removeHost,
    renameHost,
    updateHostMachine,
    deleteSharedScratch,
    forceDeprovision,
    removeSelfHostConnector,
    listHostAccess,
    setHostAccess,
    removeHostAccess,
    setHostProjectRamLimit,
    setHostOwnerSpendLimits,
    setHostPoolAccess,
    setHostDeletionProtection,
    stopHostProjects,
    restartHostProjects,
    backupHostProjects,
  };
};
