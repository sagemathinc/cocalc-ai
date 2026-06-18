export const SOFTWARE_BUILD_COMPONENTS = [
  "static",
  "hub",
  "bay",
  "project-host",
  "project",
  "tools",
  "tools-minimal",
  "cli",
  "launchpad",
  "plus",
  "star",
] as const;

export const SOFTWARE_DEPLOY_COMPONENTS = [
  "static",
  "hub",
  "bay",
  "bay-conat-router",
  "bay-conat-persist",
  "bay-frontdoor",
  "bay-cloudflared",
  "bay-scaffold",
  "host-conat-router",
  "host-conat-persist",
  "project-host",
  "project",
  "tools",
  "cli",
  "launchpad",
  "plus",
  "star",
] as const;

export type SoftwareBuildComponent = (typeof SOFTWARE_BUILD_COMPONENTS)[number];
export type SoftwareDeployComponent =
  (typeof SOFTWARE_DEPLOY_COMPONENTS)[number];

export type SoftwareComponent =
  | SoftwareBuildComponent
  | SoftwareDeployComponent;

export type SoftwareDeploymentStatus = "started" | "succeeded" | "failed";

export type SoftwareGitMetadata = {
  commit: string;
  short: string;
  branch: string | null;
  dirty: boolean;
  status_porcelain: string;
};

export type SoftwareArtifactFile = {
  name: string;
  path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
};

export type SoftwareArtifactManifest = {
  schema: "cocalc-software-artifact-v1";
  component: SoftwareBuildComponent;
  artifact_id: string;
  tag: string;
  tag_generated: boolean;
  created_at: string;
  source: {
    repo_root: string;
    src_root: string;
    branch: string | null;
    git_commit: string;
    git_short: string;
    git_dirty: boolean;
    git_status_porcelain: string;
  };
  build: {
    host: string;
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    command: string;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  };
  files: SoftwareArtifactFile[];
};

export type SoftwareListRow = {
  source: "local" | "remote" | "local+remote";
  tag: string;
  artifact_id: string;
  git: string;
  dirty: boolean;
  size: string;
  created: string;
  local?: string;
  remote?: string;
};

export type SoftwareDeploymentRecord = {
  schema: "cocalc-software-deployment-v1";
  deployment_id: string;
  component: SoftwareDeployComponent;
  artifact_component: SoftwareBuildComponent;
  profile_or_channel: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  artifact_id: string;
  tag: string;
  git: {
    commit: string;
    short: string;
    dirty: boolean;
  };
  deployed_by: {
    user?: string;
    host?: string;
    account_id?: string;
    email_address?: string;
  };
  target: {
    kind: "rocket-bay" | "project-host-fleet" | "release-channel";
    profile?: string;
    channel?: string;
    api?: string;
    remote?: string;
  };
  status: SoftwareDeploymentStatus;
  duration_ms?: number;
  error?: string;
  details?: Record<string, unknown>;
};

export type SoftwareDeploymentIndexEntry = {
  deployment_id: string;
  component: SoftwareDeployComponent;
  artifact_component: SoftwareBuildComponent;
  profile_or_channel: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  artifact_id: string;
  tag: string;
  git: {
    commit: string;
    short: string;
    dirty: boolean;
  };
  deployed_by: SoftwareDeploymentRecord["deployed_by"];
  target: SoftwareDeploymentRecord["target"];
  status: SoftwareDeploymentStatus;
  duration_ms?: number;
  error?: string;
  record_key: string;
  record_url: string;
};

export type SoftwareDeploymentIndex = {
  schema: "cocalc-software-deployment-index-v1";
  component: SoftwareDeployComponent;
  profile_or_channel: string;
  generated_at: string;
  deployments: SoftwareDeploymentIndexEntry[];
};

export type SoftwareDeploymentHistoryRow = {
  deployed_at: string;
  component: string;
  profile_or_channel: string;
  artifact_id: string;
  tag: string;
  git: string;
  dirty: boolean;
  deployed_by: string;
  target: string;
  status: string;
  duration?: string;
  error?: string;
  record?: string;
};
