import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "@cocalc/frontend/app-framework";
import type {
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
  };
};

type UseHostSoftwareVersionsOptions = {
  enabled?: boolean;
  hubSourceBaseUrl?: string;
  artifacts?: HostSoftwareArtifact[];
};

type VersionMap = Partial<
  Record<HostSoftwareArtifact, HostSoftwareAvailableVersion>
>;

type UseHostSoftwareVersionsResult = {
  loading: boolean;
  configured: VersionMap;
  configuredError?: string;
  hub: VersionMap;
  hubError?: string;
  refresh: () => Promise<void>;
};

const DEFAULT_ARTIFACTS: HostSoftwareArtifact[] = [
  "project-host",
  "project",
  "tools",
];

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Unable to load software versions.";
}

function firstRowPerArtifact(rows: HostSoftwareAvailableVersion[]): VersionMap {
  const out: VersionMap = {};
  for (const row of rows) {
    if (out[row.artifact]) continue;
    out[row.artifact] = row;
  }
  return out;
}

export function useHostSoftwareVersions(
  hub: HubClient,
  options: UseHostSoftwareVersionsOptions = {},
): UseHostSoftwareVersionsResult {
  const {
    enabled = true,
    hubSourceBaseUrl,
    artifacts = DEFAULT_ARTIFACTS,
  } = options;
  const [loading, setLoading] = useState(false);
  const [configured, setConfigured] = useState<VersionMap>({});
  const [configuredError, setConfiguredError] = useState<string>();
  const [hubVersions, setHubVersions] = useState<VersionMap>({});
  const [hubError, setHubError] = useState<string>();
  const refreshTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled || !hub.hosts.listHostSoftwareVersions) {
      return;
    }
    const token = ++refreshTokenRef.current;
    setLoading(true);
    const [configuredResult, hubResult] = await Promise.allSettled([
      hub.hosts.listHostSoftwareVersions({
        artifacts,
        channels: ["latest"],
        history_limit: 1,
      }),
      hubSourceBaseUrl
        ? hub.hosts.listHostSoftwareVersions({
            base_url: hubSourceBaseUrl,
            artifacts,
            channels: ["latest"],
            history_limit: 1,
          })
        : Promise.resolve([]),
    ]);
    if (refreshTokenRef.current !== token) {
      return;
    }
    if (configuredResult.status === "fulfilled") {
      setConfigured(firstRowPerArtifact(configuredResult.value));
      setConfiguredError(undefined);
    } else {
      setConfigured({});
      setConfiguredError(getErrorMessage(configuredResult.reason));
    }
    if (hubResult.status === "fulfilled") {
      setHubVersions(firstRowPerArtifact(hubResult.value));
      setHubError(undefined);
    } else {
      setHubVersions({});
      setHubError(getErrorMessage(hubResult.reason));
    }
    setLoading(false);
  }, [artifacts, enabled, hub, hubSourceBaseUrl]);

  useEffect(() => {
    if (!enabled) return;
    refresh().catch((err) => {
      console.error("failed to load host software versions", err);
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
    refresh,
  };
}
