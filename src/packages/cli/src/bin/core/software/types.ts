export const SOFTWARE_BUILD_COMPONENTS = [
  "static",
  "hub",
  "project-host",
  "project",
  "tools",
  "cli",
  "launchpad",
  "plus",
  "star",
] as const;

export const SOFTWARE_DEPLOY_COMPONENTS = [
  "static",
  "hub",
  "hub-conat-router",
  "hub-conat-persist",
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
  source: "local";
  tag: string;
  artifact_id: string;
  git: string;
  dirty: boolean;
  size: string;
  created: string;
  local: string;
};
