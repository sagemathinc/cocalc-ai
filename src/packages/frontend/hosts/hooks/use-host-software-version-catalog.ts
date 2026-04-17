import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type {
  HostRuntimeDeploymentRecord,
  HostSoftwareArtifact,
  HostSoftwareAvailableVersion,
  HostSoftwareChannel,
} from "@cocalc/conat/hub/api/hosts";

type HubClient = {
  hosts: {
    listHostSoftwareVersions: (opts: {
      base_url?: string;
      artifacts?: HostSoftwareArtifact[];
      channels?: HostSoftwareChannel[];
      os?: "linux" | "darwin";
      arch?: "amd64" | "arm64";
      history_limit?: number;
    }) => Promise<HostSoftwareAvailableVersion[]>;
    listHostRuntimeDeployments?: (opts: {
      scope_type: "global" | "host";
      id?: string;
    }) => Promise<HostRuntimeDeploymentRecord[]>;
  };
};

type UseHostSoftwareVersionCatalogOptions = {
  enabled?: boolean;
  hubSourceBaseUrl?: string;
  artifacts?: HostSoftwareArtifact[];
  channels?: HostSoftwareChannel[];
  historyLimit?: number;
};

type UseHostSoftwareVersionCatalogResult = {
  loading: boolean;
  configured: HostSoftwareAvailableVersion[];
  configuredError?: string;
  hub: HostSoftwareAvailableVersion[];
  hubError?: string;
  globalDeployments: HostRuntimeDeploymentRecord[];
  globalDeploymentsError?: string;
  refresh: () => Promise<void>;
};

const DEFAULT_ARTIFACTS: HostSoftwareArtifact[] = [
  "project-host",
  "project",
  "tools",
];
const DEFAULT_CHANNELS: HostSoftwareChannel[] = ["latest"];
const DEFAULT_HISTORY_LIMIT = 8;

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load software versions.";
}

function filterAvailable(
  rows: HostSoftwareAvailableVersion[],
): HostSoftwareAvailableVersion[] {
  return rows.filter((row) => row.available && !!row.version);
}

export function useHostSoftwareVersionCatalog(
  hub: HubClient,
  options: UseHostSoftwareVersionCatalogOptions = {},
): UseHostSoftwareVersionCatalogResult {
  const {
    enabled = true,
    hubSourceBaseUrl,
    artifacts = DEFAULT_ARTIFACTS,
    channels = DEFAULT_CHANNELS,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  } = options;
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<HostSoftwareAvailableVersion[]>(
    [],
  );
  const [configuredError, setConfiguredError] = useState<string>();
  const [hubVersions, setHubVersions] = useState<
    HostSoftwareAvailableVersion[]
  >([]);
  const [hubError, setHubError] = useState<string>();
  const [globalDeployments, setGlobalDeployments] = useState<
    HostRuntimeDeploymentRecord[]
  >([]);
  const [globalDeploymentsError, setGlobalDeploymentsError] =
    useState<string>();
  const refreshTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !hub.hosts.listHostSoftwareVersions) {
      return;
    }
    const token = ++refreshTokenRef.current;
    setLoading(true);
    const [configuredResult, hubResult, globalResult] =
      await Promise.allSettled([
        hub.hosts.listHostSoftwareVersions({
          artifacts,
          channels,
          history_limit: historyLimit,
        }),
        hubSourceBaseUrl
          ? hub.hosts.listHostSoftwareVersions({
              base_url: hubSourceBaseUrl,
              artifacts,
              channels,
              history_limit: historyLimit,
            })
          : Promise.resolve([]),
        hub.hosts.listHostRuntimeDeployments
          ? hub.hosts.listHostRuntimeDeployments({
              scope_type: "global",
            })
          : Promise.resolve([]),
      ]);
    if (refreshTokenRef.current !== token) {
      return;
    }
    if (configuredResult.status === "fulfilled") {
      setConfigured(filterAvailable(configuredResult.value));
      setConfiguredError(undefined);
    } else {
      setConfigured([]);
      setConfiguredError(getErrorMessage(configuredResult.reason));
    }
    if (hubResult.status === "fulfilled") {
      setHubVersions(filterAvailable(hubResult.value));
      setHubError(undefined);
    } else {
      setHubVersions([]);
      setHubError(getErrorMessage(hubResult.reason));
    }
    if (globalResult.status === "fulfilled") {
      setGlobalDeployments(globalResult.value);
      setGlobalDeploymentsError(undefined);
    } else {
      setGlobalDeployments([]);
      setGlobalDeploymentsError(getErrorMessage(globalResult.reason));
    }
    setLoading(false);
  }, [artifacts, channels, enabled, historyLimit, hub, hubSourceBaseUrl]);

  useEffect(() => {
    if (!enabled) return;
    refresh().catch((err) => {
      console.error("failed to load host software version catalog", err);
      if (refreshTokenRef.current >= 0) {
        setLoading(false);
      }
    });
  }, [enabled, refresh]);

  return {
    loading,
    configured,
    configuredError,
    hub: hubVersions,
    hubError,
    globalDeployments,
    globalDeploymentsError,
    refresh,
  };
}
