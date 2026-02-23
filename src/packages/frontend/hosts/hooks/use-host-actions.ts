import type { Host, HostLroResponse } from "@cocalc/conat/hub/api/hosts";
import type { HostDrainOptions } from "../types";

type HubClient = {
  hosts: {
    startHost: (opts: { id: string }) => Promise<HostLroResponse>;
    stopHost: (opts: { id: string; skip_backups?: boolean }) => Promise<HostLroResponse>;
    restartHost?: (opts: {
      id: string;
      mode?: "reboot" | "hard";
    }) => Promise<HostLroResponse>;
    drainHost?: (opts: {
      id: string;
      dest_host_id?: string;
      force?: boolean;
      allow_offline?: boolean;
      parallel?: number;
    }) => Promise<HostLroResponse>;
    deleteHost: (opts: { id: string; skip_backups?: boolean }) => Promise<HostLroResponse>;
    forceDeprovisionHost?: (opts: { id: string }) => Promise<HostLroResponse>;
    removeSelfHostConnector?: (opts: { id: string }) => Promise<HostLroResponse>;
    renameHost?: (opts: { id: string; name: string }) => Promise<unknown>;
    updateHostMachine?: (opts: {
      id: string;
      cloud?: string;
      cpu?: number;
      ram_gb?: number;
      disk_gb?: number;
      disk_type?: "ssd" | "balanced" | "standard" | "ssd_io_m3";
      machine_type?: string;
      gpu_type?: string;
      gpu_count?: number;
      storage_mode?: "ephemeral" | "persistent";
      region?: string;
      zone?: string;
    }) => Promise<unknown>;
  };
};

type UseHostActionsOptions = {
  hub: HubClient;
  setHosts: React.Dispatch<React.SetStateAction<Host[]>>;
  refresh: () => Promise<Host[]>;
  onHostOp?: (host_id: string, op: HostLroResponse) => void;
};

export const useHostActions = ({
  hub,
  setHosts,
  refresh,
  onHostOp,
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
        const op = await hub.hosts.startHost({ id });
        onHostOp?.(id, op);
      } else {
        const op = await hub.hosts.stopHost({
          id,
          skip_backups: opts?.skip_backups,
        });
        onHostOp?.(id, op);
      }
    } catch (err) {
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
      const op = await hub.hosts.restartHost({ id, mode });
      onHostOp?.(id, op);
    } catch (err) {
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
        skip_backups: opts?.skip_backups,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
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
        dest_host_id: opts?.dest_host_id,
        force: opts?.force,
        allow_offline: opts?.allow_offline,
        parallel: opts?.parallel,
      });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
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
        prev.map((host) => (host.id === id ? { ...host, name: cleaned } : host)),
      );
      await refresh();
    } catch (err) {
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
      machine_type?: string;
      gpu_type?: string;
      gpu_count?: number;
      storage_mode?: "ephemeral" | "persistent";
      region?: string;
      zone?: string;
    },
  ) => {
    if (!hub.hosts.updateHostMachine) {
      return;
    }
    try {
      await hub.hosts.updateHostMachine({ id, ...opts });
      await refresh();
    } catch (err) {
      console.error(err);
    }
  };

  const forceDeprovision = async (id: string) => {
    if (!hub.hosts.forceDeprovisionHost) {
      return;
    }
    try {
      const op = await hub.hosts.forceDeprovisionHost({ id });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      console.error(err);
    }
  };

  const removeSelfHostConnector = async (id: string) => {
    if (!hub.hosts.removeSelfHostConnector) {
      return;
    }
    try {
      const op = await hub.hosts.removeSelfHostConnector({ id });
      onHostOp?.(id, op);
      await refresh();
    } catch (err) {
      console.error(err);
    }
  };

  return {
    setStatus,
    restartHost,
    drainHost,
    removeHost,
    renameHost,
    updateHostMachine,
    forceDeprovision,
    removeSelfHostConnector,
  };
};
