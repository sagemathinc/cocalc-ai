import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { humanSize } from "@cocalc/util/misc";

import {
  loadAuthConfig as loadDefaultAuthConfig,
  type AuthConfig,
} from "../../core/auth-config";
import { emitSuccess, printArrayTable } from "../core/cli-output";
import {
  compactTimestamp,
  chooseGeneratedTag,
  createSoftwareArtifactId,
  isSoftwareLatestSelector,
  parseSoftwareBuildComponent,
  parseSoftwareDeployComponent,
  validateSoftwareArtifactId,
  validateSoftwareTag,
} from "../core/software/artifact-id";
import {
  artifactDir,
  copyArtifactFile,
  listLocalManifests,
  manifestToListRow,
  remoteIndexEntryToListRow,
  resolveSoftwareLocalStore,
  writeLocalManifest,
} from "../core/software/local-store";
import {
  deploymentRecordKey,
  indexKey,
  loadDefaultSoftwareR2Client,
  manifestRemoteEntry,
  publishHostBootstrapArtifact,
  publishHostCompatibilityArtifact,
  publishReleaseInstaller,
  publishReleasePowerShellInstaller,
  publishReleaseChannelArtifact,
  readDeploymentIndex,
  readRemoteIndex,
  resolveSoftwareRemoteConfig,
  uploadSoftwareArtifact,
  validateSoftwareReleaseChannel,
  writeDeploymentRecord,
  type SoftwareRemoteIndexEntry,
  type SoftwareR2Client,
} from "../core/software/remote-store";
import type {
  SoftwareArtifactManifest,
  SoftwareBuildComponent,
  SoftwareDeployComponent,
  SoftwareDeploymentHistoryRow,
  SoftwareDeploymentIndexEntry,
  SoftwareDeploymentRecord,
  SoftwareGitMetadata,
  SoftwareListRow,
} from "../core/software/types";
import {
  SOFTWARE_BUILD_COMPONENTS,
  SOFTWARE_DEPLOY_COMPONENTS,
} from "../core/software/types";

export type SoftwareCommandDeps = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  gitMetadata?: (cwd: string) => SoftwareGitMetadata;
  repoRoot?: (cwd: string) => string;
  runCommand?: (
    command: string,
    args: string[],
    options?: {
      stdio?: "inherit" | "pipe";
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ) => Promise<number>;
  runCommandOutput?: (
    command: string,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  deployPreflight?: () => Promise<void>;
  r2Client?: SoftwareR2Client | (() => SoftwareR2Client);
  loadAuthConfig?: () => AuthConfig;
  fetch?: typeof fetch;
};

type BuildOptions = {
  localStore?: string;
  fromFile?: string;
  fromDirectory?: string;
  artifactName?: string;
  artifactId?: string;
  keepBuildDir?: boolean;
};

type ListOptions = {
  localStore?: string;
  limit?: string;
  remote?: boolean;
  envFile?: string;
};

type PushOptions = {
  localStore?: string;
  envFile?: string;
  build?: boolean;
};

type DeployOptions = {
  localStore?: string;
  envFile?: string;
  config?: string;
  remote?: string;
  api?: string;
  toolsMinimal?: string;
  build?: boolean;
  rollout?: boolean;
  rolloutCanary?: string;
  rolloutMaxConcurrent?: string;
  rolloutCanaryStabilizeSeconds?: string;
  rolloutStabilizeSeconds?: string;
  bootstrapScope?: string;
  bootstrapPublishChannel?: string;
};

function parseHostBootstrapScope(
  value: string | undefined,
): "full" | "helpers" | "environment" | undefined {
  if (value == null) return undefined;
  if (value === "full" || value === "helpers" || value === "environment") {
    return value;
  }
  throw new Error("--bootstrap-scope must be full, helpers, or environment");
}

function parseHostBootstrapPublishChannel(
  value: string | undefined,
): "latest" | "staging" | undefined {
  if (value == null) return undefined;
  if (value === "latest" || value === "staging") return value;
  throw new Error("--bootstrap-publish-channel must be latest or staging");
}

type HistoryOptions = {
  envFile?: string;
  limit?: string;
  wide?: boolean;
};

type RollbackOptions = DeployOptions;

type SmokeOptions = {
  api?: string;
  remote?: string;
  host?: string;
  checkTimeoutMs?: string;
  timeout?: string;
};

type SoftwareSmokeCheck = {
  check: string;
  status: "ok" | "failed";
  detail: string;
  duration?: string;
};

const BUILD_COMPONENTS_HELP = SOFTWARE_BUILD_COMPONENTS.join("|");
const DEPLOY_COMPONENTS_HELP = SOFTWARE_DEPLOY_COMPONENTS.join("|");
const INFO_COMPONENTS = Array.from(
  new Set([...SOFTWARE_BUILD_COMPONENTS, ...SOFTWARE_DEPLOY_COMPONENTS]),
) as SoftwareInfoComponent[];
const INFO_COMPONENTS_HELP = INFO_COMPONENTS.join("|");
const BUILD_COMPONENT_ARGUMENT = `software component (${BUILD_COMPONENTS_HELP})`;
const DEPLOY_COMPONENT_ARGUMENT = `software component (${DEPLOY_COMPONENTS_HELP})`;
const INFO_COMPONENT_ARGUMENT = `software component (${INFO_COMPONENTS_HELP})`;
const PROFILE_OR_CHANNEL_ARGUMENT =
  "site profile (see cocalc auth list) or release channel (dev, candidate or stable)";

type SoftwareInfoComponent = SoftwareBuildComponent | SoftwareDeployComponent;

type HostManagedSoftwareComponent =
  | "project-host"
  | "conat-router"
  | "conat-persist"
  | "acp-worker";

const HOST_RUNTIME_STACK_COMPONENTS: HostManagedSoftwareComponent[] = [
  "project-host",
  "conat-router",
  "conat-persist",
  "acp-worker",
];

type SoftwareComponentInfo = {
  component: SoftwareInfoComponent;
  title: string;
  description: string;
  status: "build-and-deploy" | "build-only" | "deploy-only";
  artifact_component?: SoftwareBuildComponent;
  target_kind?: "rocket-bay" | "project-host-fleet" | "release-channel";
  purpose: string;
  lifecycle: string[];
  commands: {
    build?: string[];
    push?: string[];
    deploy?: string[];
    smoke?: string[];
    history?: string[];
    rollback?: string[];
  };
  related_components: string[];
  operator_notes: string[];
  agent_notes: string[];
  common_failure_modes: string[];
};

function parseSoftwareInfoComponent(value: string): SoftwareInfoComponent {
  if (INFO_COMPONENTS.includes(value as SoftwareInfoComponent)) {
    return value as SoftwareInfoComponent;
  }
  throw new Error(`unknown software component: ${value}`);
}

function parseDeployComponentSelector({
  componentSelectorArg,
  targetArg,
  legacyTargetArg,
}: {
  componentSelectorArg: string;
  targetArg: string | undefined;
  legacyTargetArg: string | undefined;
}): {
  components: SoftwareDeployComponent[];
  selector: string;
  profileOrChannel: string;
  selectorExplicit: boolean;
} {
  const componentSelector = `${componentSelectorArg ?? ""}`.trim();
  const target = `${targetArg ?? ""}`.trim();
  const legacyTarget = `${legacyTargetArg ?? ""}`.trim();
  if (!componentSelector) {
    throw new Error("software deploy requires <component[:tag]>");
  }
  if (legacyTarget) {
    return {
      components: parseSoftwareDeployComponents(componentSelector),
      selector: validateSoftwareDeploySelector(target),
      profileOrChannel: legacyTarget,
      selectorExplicit: true,
    };
  }
  if (!target) {
    throw new Error("software deploy requires <profile-or-channel>");
  }
  const [componentRaw, selectorRaw, ...extra] = componentSelector.split(":");
  if (extra.length > 0) {
    throw new Error("software deploy component selector has too many ':'");
  }
  const components = parseSoftwareDeployComponents(componentRaw);
  if (selectorRaw != null) {
    return {
      components,
      selector: validateSoftwareDeploySelector(selectorRaw),
      profileOrChannel: target,
      selectorExplicit: true,
    };
  }
  return {
    components,
    selector: "latest",
    profileOrChannel: target,
    selectorExplicit: false,
  };
}

function parseSoftwareDeployComponents(
  value: string,
): SoftwareDeployComponent[] {
  const rawComponents = `${value ?? ""}`
    .split(",")
    .map((component) => component.trim());
  if (rawComponents.length === 0 || rawComponents.every((value) => !value)) {
    throw new Error(
      "software deploy requires <component[,component...][:tag]>",
    );
  }
  if (rawComponents.some((value) => !value)) {
    throw new Error("software deploy component list contains an empty entry");
  }
  return [
    ...new Set(
      rawComponents.map((component) => parseSoftwareDeployComponent(component)),
    ),
  ];
}

function parseBuildComponentSelector({
  componentSelectorArg,
  legacyTagArg,
}: {
  componentSelectorArg: string;
  legacyTagArg?: string;
}): {
  component: SoftwareBuildComponent;
  tagArg: string | undefined;
} {
  const { componentRaw, selectorRaw } = splitSoftwareComponentSelector({
    value: componentSelectorArg,
    command: "build",
  });
  return {
    component: parseSoftwareBuildComponent(componentRaw),
    tagArg:
      legacyTagArg != null && `${legacyTagArg}`.trim() !== ""
        ? validateSoftwareTag(legacyTagArg)
        : selectorRaw == null
          ? undefined
          : validateSoftwareTag(selectorRaw),
  };
}

function parsePushComponentSelector({
  componentSelectorArg,
  legacySelectorArg,
  allowMissingSelector = false,
}: {
  componentSelectorArg: string;
  legacySelectorArg?: string;
  allowMissingSelector?: boolean;
}): {
  component: SoftwareBuildComponent;
  selector: string | undefined;
} {
  const { componentRaw, selectorRaw } = splitSoftwareComponentSelector({
    value: componentSelectorArg,
    command: "push",
  });
  const selector =
    legacySelectorArg != null && `${legacySelectorArg}`.trim() !== ""
      ? legacySelectorArg
      : selectorRaw;
  if (selector == null || `${selector}`.trim() === "") {
    if (allowMissingSelector) {
      return {
        component: parseSoftwareBuildComponent(componentRaw),
        selector: undefined,
      };
    }
    throw new Error("software push requires <component:tag-or-id>");
  }
  return {
    component: parseSoftwareBuildComponent(componentRaw),
    selector: validateSoftwareDeploySelector(selector),
  };
}

function isHostCompatibilityComponent(
  component: SoftwareBuildComponent,
): component is "project-host" | "container-runtime" | "project" | "tools" {
  return (
    component === "project-host" ||
    component === "container-runtime" ||
    component === "project" ||
    component === "tools"
  );
}

function splitSoftwareComponentSelector({
  value,
  command,
}: {
  value: string;
  command: string;
}): { componentRaw: string; selectorRaw: string | undefined } {
  const componentSelector = `${value ?? ""}`.trim();
  if (!componentSelector) {
    throw new Error(`software ${command} requires <component[:tag]>`);
  }
  const [componentRaw, selectorRaw, ...extra] = componentSelector.split(":");
  if (extra.length > 0) {
    throw new Error(`software ${command} component selector has too many ':'`);
  }
  return { componentRaw, selectorRaw };
}

function validateSoftwareDeploySelector(selector: string): string {
  const trimmed = `${selector ?? ""}`.trim();
  if (!trimmed) {
    throw new Error("software deploy artifact selector must not be empty");
  }
  return isSoftwareLatestSelector(trimmed)
    ? trimmed
    : validateSoftwareTag(trimmed);
}

function splitDeployTargets(value: string): string[] {
  const targets = `${value ?? ""}`
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  if (targets.length === 0) {
    throw new Error("software deploy requires <profile-or-channel>");
  }
  return [...new Set(targets)];
}

function assertSingleReleaseDeployTarget({
  component,
  targets,
}: {
  component: SoftwareDeployComponent;
  targets: string[];
}): void {
  if (targets.length <= 1) return;
  if (
    releaseDeployTargetForComponent(component) ||
    starDeployTargetForComponent(component)
  ) {
    throw new Error(
      `software deploy ${component} accepts exactly one release channel`,
    );
  }
}

function deployTargetKindForComponent(
  component: SoftwareDeployComponent,
): "site-profile" | "release-channel" {
  return releaseDeployTargetForComponent(component) ||
    starDeployTargetForComponent(component)
    ? "release-channel"
    : "site-profile";
}

function softwareInfoPayload(componentArg: string | undefined): {
  schema: "cocalc-software-info-v1";
  audience: "agent";
  overview?: ReturnType<typeof softwareInfoOverview>;
  component?: SoftwareComponentInfo;
  components?: SoftwareComponentInfo[];
  agent_guidance: string[];
} {
  const agentGuidance = [
    "Use build/list/push for immutable artifacts, deploy for site profiles or release channels, smoke after deploy, history to confirm sealed deployment records, and rollback for known-good artifacts.",
    "Treat release channels as dev, candidate, or stable. Treat site profiles as names from cocalc auth list.",
    "Prefer explicit profile/channel arguments. Do not rely on ambient defaults for deploy, smoke, history, or rollback.",
  ];
  if (componentArg) {
    const component = parseSoftwareInfoComponent(componentArg);
    return {
      schema: "cocalc-software-info-v1",
      audience: "agent",
      component: softwareComponentInfo(component),
      agent_guidance: agentGuidance,
    };
  }
  return {
    schema: "cocalc-software-info-v1",
    audience: "agent",
    overview: softwareInfoOverview(),
    components: INFO_COMPONENTS.map(softwareComponentInfo),
    agent_guidance: agentGuidance,
  };
}

function softwareInfoOverview() {
  return {
    build_components: SOFTWARE_BUILD_COMPONENTS,
    deploy_components: SOFTWARE_DEPLOY_COMPONENTS,
    release_channels: ["dev", "candidate", "stable"],
    site_profile_source: "cocalc auth list",
    artifact_store: "R2 software artifact store",
    deployment_history_store: "R2 software deployment history records",
    component_groups: {
      bay: [
        "static",
        "hub",
        "bay",
        "bay-conat-router",
        "bay-conat-persist",
        "bay-frontdoor",
        "bay-cloudflared",
        "bay-scaffold",
      ],
      project_hosts: [
        "host-bootstrap",
        "project-host",
        "container-runtime",
        "project",
        "tools",
        "host-conat-router",
        "host-conat-persist",
        "host-acp-worker",
        "host-runtime-stack",
      ],
      release_channels: ["cli", "launchpad", "plus", "tools-minimal", "star"],
    },
  };
}

function softwareComponentInfo(
  component: SoftwareInfoComponent,
): SoftwareComponentInfo {
  const info = rawSoftwareComponentInfo(component);
  return {
    ...info,
    description: softwareComponentDescription(component),
  };
}

function rawSoftwareComponentInfo(
  component: SoftwareInfoComponent,
): Omit<SoftwareComponentInfo, "description"> {
  if (
    component === "bay-conat-router" ||
    component === "bay-conat-persist" ||
    component === "bay-frontdoor" ||
    component === "bay-cloudflared" ||
    component === "bay-scaffold"
  ) {
    const service = component.replace(/^bay-/, "");
    const scaffoldOnly = component === "bay-scaffold";
    return {
      component,
      title: scaffoldOnly
        ? "Bay scaffold installer"
        : `Bay service: ${service}`,
      status: "deploy-only",
      artifact_component: "bay",
      target_kind: "rocket-bay",
      purpose: scaffoldOnly
        ? "Install or refresh the bay scaffold without rolling a runtime bundle."
        : `Deploy only the ${service} bay service from a full bay artifact.`,
      lifecycle: [
        "Build a bay artifact.",
        "Push or let deploy push the selected artifact.",
        scaffoldOnly
          ? "Deploy with the Rocket scaffold-only path."
          : `Deploy with the Rocket one-service path for ${service}.`,
        "Use history and rollback against this deploy component name, not against bay.",
      ],
      commands: {
        build: ["cocalc software build bay:<tag>"],
        push: ["cocalc software push bay:<tag-or-id>"],
        deploy: [`cocalc software deploy ${component}:<tag-or-id> <profile>`],
        smoke: ["cocalc software smoke bay <profile>"],
        history: [`cocalc software history ${component} <profile>`],
        rollback: [
          `cocalc software rollback ${component} <profile> <artifact-id>`,
        ],
      },
      related_components: ["bay"],
      operator_notes: [
        "This is intentionally narrower than a full bay deploy.",
        "The artifact id is a bay artifact id even though the deployment component is service-specific.",
      ],
      agent_notes: [
        "Resolve artifacts using artifact_component=bay.",
        "Deployment records should use the service component name so rollback/history remain service-scoped.",
      ],
      common_failure_modes: [
        "Selected bay artifact is missing from local and remote stores.",
        "Rocket cannot infer the bay SSH target from the profile API URL.",
      ],
    };
  }

  if (component === "host-bootstrap") {
    return {
      component,
      title: "Project-host bootstrap script",
      status: "build-and-deploy",
      artifact_component: "host-bootstrap",
      target_kind: "project-host-fleet",
      purpose:
        "Publish the bootstrap.py used when project hosts bootstrap or refresh host-level operational helpers.",
      lifecycle: [
        "Record packages/server/cloud/bootstrap/bootstrap.py as an immutable software artifact.",
        "Push the artifact to the R2 software artifact store.",
        "Publish immutable bootstrap.py and bootstrap.py.sha256 objects.",
        "Optionally publish a mutable latest or staging channel only when explicitly requested.",
        "Reconcile online project hosts so they refresh bootstrap-managed host state.",
      ],
      commands: {
        build: ["cocalc software build host-bootstrap:<tag>"],
        push: ["cocalc software push host-bootstrap:<tag-or-id>"],
        deploy: [
          "cocalc software deploy --build host-bootstrap:<tag> <profile>",
          "cocalc software deploy --build --rollout --bootstrap-scope helpers host-bootstrap:<tag> <profile>",
          "cocalc software deploy --build --rollout --bootstrap-scope full host-bootstrap:<tag> <profile>",
        ],
        smoke: ["cocalc software smoke host-bootstrap <profile>"],
        history: ["cocalc software history host-bootstrap <profile>"],
        rollback: [
          "cocalc software rollback host-bootstrap <profile> <artifact-id>",
          "cocalc software rollback host-bootstrap <profile> <artifact-id> --rollout --bootstrap-scope helpers",
        ],
      },
      related_components: ["project-host"],
      operator_notes: [
        "This replaces the old manual publish:bootstrap step for normal deploys.",
        "Mutable bootstrap channels are never inferred from a site profile; pass --bootstrap-publish-channel explicitly when promotion is intentional.",
        "Deploy updates desired state without touching running hosts unless --rollout is explicit.",
        "A rollout requires --bootstrap-scope so daemon restart behavior is explicit.",
        "Use helpers for privileged helper, sudo, networking, I/O, and host logging policy changes; it does not restart project-host, Conat, or ACP.",
        "Use full only when complete host convergence is required; it restarts project-host.",
        "Use this after bootstrap/sysctl/rootctl changes that do not require rebuilding project-host runtime.",
      ],
      agent_notes: [
        "Build does not run pnpm; it records the source bootstrap.py file.",
        "Deploy publishes the latest bootstrap object and desired state; --rollout additionally runs host reconcile --all-online --wait.",
      ],
      common_failure_modes: [
        "R2 software credentials are missing.",
        "The profile has no reachable online hosts to reconcile.",
        "An old deployed project-host runtime does not yet know how to consume the changed bootstrap behavior.",
      ],
    };
  }

  if (
    component === "host-conat-router" ||
    component === "host-conat-persist" ||
    component === "host-acp-worker" ||
    component === "host-runtime-stack"
  ) {
    const fullStack = component === "host-runtime-stack";
    const managedComponents = hostManagedComponentsForDeployComponent(
      component as SoftwareDeployComponent,
    );
    const service = fullStack
      ? "runtime stack"
      : component.replace(/^host-/, "");
    return {
      component,
      title: fullStack
        ? "Project-host managed runtime stack"
        : `Project-host service: ${service}`,
      status: "deploy-only",
      artifact_component: "project-host",
      target_kind: "project-host-fleet",
      purpose: fullStack
        ? "Explicitly roll the full project-host managed runtime stack using a project-host artifact."
        : `Roll only the ${service} managed service on online project hosts using a project-host artifact.`,
      lifecycle: [
        "Build a project-host artifact.",
        "Publish host compatibility metadata.",
        fullStack
          ? "Run one durable canary-first campaign for project-host, conat-router, conat-persist, and acp-worker."
          : `Run one durable canary-first campaign for ${service}.`,
        "Promote the artifact and selected component defaults only after every online host converges.",
      ],
      commands: {
        build: ["cocalc software build project-host:<tag>"],
        push: ["cocalc software push project-host:<tag-or-id>"],
        deploy: [`cocalc software deploy ${component}:<tag-or-id> <profile>`],
        smoke: ["cocalc software smoke project-host <profile>"],
        history: [`cocalc software history ${component} <profile>`],
        rollback: [
          `cocalc software rollback ${component} <profile> <artifact-id>`,
        ],
      },
      related_components: ["project-host"],
      operator_notes: [
        fullStack
          ? "This is intentionally broad and should be used only when all host-managed services must move together."
          : "This rolls only the selected managed component after safely staging the shared project-host artifact.",
        "Offline hosts converge when the host deployment machinery sees them later.",
      ],
      agent_notes: [
        "Resolve artifacts using artifact_component=project-host.",
        `Managed component target(s): ${managedComponents?.join(", ") ?? "none"}.`,
        "Expect one host deploy rollout-fleet subprocess during deploy.",
      ],
      common_failure_modes: [
        "No online representative host is available for smoke verification.",
        "Host deploy status reports version_state other than aligned.",
      ],
    };
  }

  switch (component) {
    case "static":
      return {
        component,
        title: "Bay static frontend and CDN assets",
        status: "build-and-deploy",
        artifact_component: "static",
        target_kind: "rocket-bay",
        purpose:
          "Ship browser frontend, CDN, public, webapp, and provider setup assets to a bay.",
        lifecycle: [
          "Build frontend and CDN assets and package them together in a static bundle.",
          "Push to R2 or let deploy push it.",
          "Deploy to a site profile with Rocket scope static.",
          "Smoke HTTP bootstrap and static asset endpoints.",
        ],
        commands: {
          build: ["cocalc software build static:<tag>"],
          push: ["cocalc software push static:<tag-or-id>"],
          deploy: ["cocalc software deploy static:<tag-or-id> <profile>"],
          smoke: ["cocalc software smoke static <profile>"],
          history: ["cocalc software history static <profile>"],
          rollback: ["cocalc software rollback static <profile> <artifact-id>"],
        },
        related_components: ["hub", "bay"],
        operator_notes: [
          "Static deploys should not require hub worker restarts just to serve new static files.",
          "Use history after deploy to confirm the record sealed as succeeded.",
        ],
        agent_notes: [
          "Rocket scope is static and the artifact component is static.",
          "Smoke uses the profile API URL and does not need SSH.",
        ],
        common_failure_modes: [
          "Static bundle missing the expected manifest, frontend, or CDN assets.",
          "Profile does not resolve an API URL for smoke.",
        ],
      };
    case "hub":
      return {
        component,
        title: "Bay hub workers",
        status: "build-and-deploy",
        artifact_component: "hub",
        target_kind: "rocket-bay",
        purpose: "Deploy hub worker runtime code on a bay.",
        lifecycle: [
          "Build the hub-only runtime artifact.",
          "Push to R2 or let deploy push it.",
          "Deploy to a site profile with Rocket scope hub.",
          "Smoke API endpoints and Rocket host-route health.",
        ],
        commands: {
          build: ["cocalc software build hub:<tag>"],
          push: ["cocalc software push hub:<tag-or-id>"],
          deploy: ["cocalc software deploy hub:<tag-or-id> <profile>"],
          smoke: ["cocalc software smoke hub <profile>"],
          history: ["cocalc software history hub <profile>"],
          rollback: ["cocalc software rollback hub <profile> <artifact-id>"],
        },
        related_components: ["static", "bay"],
        operator_notes: [
          "Prefer hub artifacts for hub-only fixes; they are smaller and faster than full bay artifacts.",
          "A failed deploy should still leave a failed history record when R2 is available.",
        ],
        agent_notes: [
          "Rocket scope is hub and the artifact component is hub.",
          "Smoke runs HTTP checks plus a Rocket host-route health subprocess.",
        ],
        common_failure_modes: [
          "Hub workers fail health after rollout.",
          "Rocket target profile lacks remote or API resolution.",
        ],
      };
    case "bay":
      return {
        component,
        title: "Full bay runtime",
        status: "build-and-deploy",
        artifact_component: "bay",
        target_kind: "rocket-bay",
        purpose:
          "Deploy the full bay runtime bundle and scaffold-compatible services.",
        lifecycle: [
          "Build the full bay runtime artifact.",
          "Push to R2 or let deploy push it.",
          "Deploy to a site profile with Rocket scope bay.",
          "Smoke bay HTTP and health checks.",
        ],
        commands: {
          build: ["cocalc software build bay:<tag>"],
          push: ["cocalc software push bay:<tag-or-id>"],
          deploy: ["cocalc software deploy bay:<tag-or-id> <profile>"],
          smoke: ["cocalc software smoke bay <profile>"],
          history: ["cocalc software history bay <profile>"],
          rollback: ["cocalc software rollback bay <profile> <artifact-id>"],
        },
        related_components: [
          "hub",
          "static",
          "bay-conat-router",
          "bay-conat-persist",
          "bay-frontdoor",
          "bay-cloudflared",
          "bay-scaffold",
        ],
        operator_notes: [
          "Use service-specific bay deploy components when only one bay service needs to move.",
          "Full bay deploys have the broadest blast radius among bay components.",
        ],
        agent_notes: [
          "Rocket scope is bay and artifact component is bay.",
          "Service deploy components also resolve the bay artifact index.",
        ],
        common_failure_modes: [
          "Scaffold and runtime expectations drift.",
          "One bay service fails to restart or pass health checks.",
        ],
      };
    case "project-host":
      return projectHostArtifactInfo({
        component,
        title: "Project-host runtime",
        purpose: "Upgrade project host runtime code across online hosts.",
        upgradeArtifact: "project-host",
        notes: [
          "This is the primary artifact for project-host agent/runtime fixes.",
          "Host service subcomponents use project-host artifacts too.",
        ],
      });
    case "container-runtime":
      return projectHostArtifactInfo({
        component,
        title: "Project-host container runtime",
        purpose:
          "Install the pinned Podman, conmon, and crun runtime used by project hosts.",
        upgradeArtifact: "container-runtime",
        notes: [
          "This artifact does not replace the operating system Podman.",
          "Deploy through a single staging canary before any fleet rollout.",
        ],
      });
    case "project":
      return projectHostArtifactInfo({
        component,
        title: "Project bundle",
        purpose:
          "Upgrade the project runtime bundle used by projects on hosts.",
        upgradeArtifact: "project",
        notes: [
          "Smoke verifies host deploy status and project bundle observation on a representative host.",
        ],
      });
    case "tools":
      return projectHostArtifactInfo({
        component,
        title: "Full project tools",
        purpose:
          "Upgrade full project tools bundles for supported project-host CPU architectures.",
        upgradeArtifact: "tools",
        notes: [
          "Tools builds intentionally include both linux/amd64 and linux/arm64 because project hosts can be either architecture.",
          "Tools deploys install the immutable artifact on every online host without restarting managed host services.",
        ],
      });
    case "tools-minimal":
      return {
        component,
        title: "Minimal tools for Plus",
        status: "build-only",
        artifact_component: "tools-minimal",
        purpose:
          "Publish small cross-platform tools bundles consumed by CoCalc Plus installers.",
        lifecycle: [
          "Build tools-minimal artifacts.",
          "Push them to the R2 artifact store.",
          "Coordinate promotion with plus using cocalc software deploy plus:<tag-or-id> <channel> --tools-minimal.",
        ],
        commands: {
          build: ["cocalc software build tools-minimal:<tag>"],
          push: ["cocalc software push tools-minimal:<tag-or-id>"],
          deploy: [
            "cocalc software deploy plus:<tag-or-id> <channel> --tools-minimal <tools-tag-or-id>",
          ],
        },
        related_components: ["plus"],
        operator_notes: [
          "There is no standalone tools-minimal deploy component.",
          "For Plus, promote plus and tools-minimal together so installers see a compatible pair.",
        ],
        agent_notes: [
          "Use component=tools-minimal for artifact lookup and component=plus for deployment history.",
          "When --tools-minimal is omitted, plus deploy attempts to use the same selector as plus.",
        ],
        common_failure_modes: [
          "Plus deploy fails because no matching tools-minimal artifact exists.",
          "Only one platform bundle exists when installers expect multiple platforms.",
        ],
      };
    case "cli":
    case "launchpad":
    case "plus":
      return releaseComponentInfo(component);
    case "star":
      return {
        component,
        title: "CoCalc Star",
        status: "build-and-deploy",
        artifact_component: "star",
        target_kind: "release-channel",
        purpose:
          "Build immutable Star GitHub release assets and promote dev/candidate/stable channel releases.",
        lifecycle: [
          "Build Star GitHub release assets.",
          "Upload immutable release assets to GitHub.",
          "Deploy by promoting an immutable release to dev, candidate, or stable.",
          "Smoke the selected release channel with the Star smoke script.",
        ],
        commands: {
          build: ["cocalc software build star:<tag>"],
          push: ["cocalc software push star:<tag-or-id>"],
          deploy: ["cocalc software deploy star:<tag-or-id> <channel>"],
          smoke: ["cocalc software smoke star <channel>"],
          history: ["cocalc software history star <channel>"],
          rollback: ["cocalc software rollback star <channel> <artifact-id>"],
        },
        related_components: [],
        operator_notes: [
          "Star promotion validates that the immutable GitHub release exists before moving a channel.",
          "VM-level Star smoke can be done manually when operator trust is more important than automation speed.",
        ],
        agent_notes: [
          "Channel deploy target is a release channel, not a site profile.",
          "Default GitHub repo is sagemathinc/cocalc-ai unless COCALC_STAR_GITHUB_REPO is set.",
        ],
        common_failure_modes: [
          "Immutable GitHub release assets were not uploaded before channel promotion.",
          "GitHub CLI auth is missing or cannot view/promote the release.",
        ],
      };
  }
}

function softwareComponentDescription(
  component: SoftwareInfoComponent,
): string {
  switch (component) {
    case "static":
      return "Static is the browser-facing frontend payload for a bay: compiled app bundles, public assets, webapp assets, and setup scripts. Deploying it updates what browsers download without changing project-host software or the hub runtime.";
    case "hub":
      return "Hub is the control-plane runtime for a bay: account/project routing, APIs, orchestration, and backend logic that runs in hub workers. Use this for hub-only code changes when the frontend and project-host software do not need to move.";
    case "bay":
      return "Bay is the broad runtime artifact for a Rocket-managed bay, including hub runtime content, bay services, scaffold-compatible files, and operational helpers. It is the escape hatch for coordinated bay-side runtime changes, but has a wider blast radius than hub or service-specific deploys.";
    case "bay-conat-router":
      return "This component targets the bay-side Conat router service that routes control-plane Conat traffic for the bay. It deploys from a full bay artifact but restarts only the router service instead of rolling the whole bay runtime.";
    case "bay-conat-persist":
      return "This component targets the bay-side Conat persist service that stores durable Conat state for the bay. It deploys from a full bay artifact but keeps the operation scoped to the persist service.";
    case "bay-frontdoor":
      return "Frontdoor is the bay-side sticky-session and request routing service in front of hub workers. Use this component for frontdoor code or unit changes without intentionally restarting unrelated bay services.";
    case "bay-cloudflared":
      return "Cloudflared is the bay tunnel helper that connects the bay to Cloudflare-managed ingress. This deploy path is intentionally separate so tunnel-related changes do not imply a hub worker rollout.";
    case "bay-scaffold":
      return "The bay scaffold is the systemd units, scripts, and environment templates that define how bay services run. Deploy this when operational wiring changes but application runtime code does not need a full rollout.";
    case "host-bootstrap":
      return "Host-bootstrap is the bootstrap.py entry point project hosts download for host-level setup and helper refreshes. Deploying it publishes immutable objects and reconciles online project hosts; mutable channel promotion is explicit.";
    case "host-conat-router":
      return "This component targets the project-host-local Conat router managed component, not the bay router. It uses a project-host artifact and reconciles the managed component across online project hosts.";
    case "host-conat-persist":
      return "This component targets the project-host-local Conat persist managed component, not the bay persist service. It uses a project-host artifact and reconciles only that managed component across online hosts.";
    case "host-acp-worker":
      return "This component targets the project-host ACP worker managed component. It uses a project-host artifact and applies the worker drain/replacement policy without intentionally restarting project-host, conat-router, or conat-persist.";
    case "host-runtime-stack":
      return "This explicit broad target rolls the full project-host managed runtime stack: project-host, host-local conat-router, host-local conat-persist, and acp-worker. Use it only when all host-managed services must move together.";
    case "project-host":
      return "Project-host is the host agent/runtime that supervises projects, host services, RootFS operations, and host-side deployment state. Deploy it when project-host control logic changes.";
    case "container-runtime":
      return "Container-runtime is the separately versioned Podman, conmon, and crun stack used by project hosts. It installs under /opt/cocalc and leaves the operating system Podman untouched.";
    case "project":
      return "Project is the runtime bundle that runs inside user projects and provides project daemons and project-level services. Deploy it when project behavior changes independently of the host agent.";
    case "tools":
      return "Tools is the full project tools bundle distributed to project hosts for both supported Linux CPU architectures. It contains host/project helper binaries and must support amd64 and arm64 project hosts.";
    case "tools-minimal":
      return "Tools-minimal is the small cross-platform tools payload consumed by CoCalc Plus installers. It is build/push-only as a standalone artifact and is promoted together with Plus.";
    case "cli":
      return "CLI is the standalone `cocalc` command-line binary released through dev, candidate, and stable channels. It is not deployed to a bay; promotion updates public installer channel manifests.";
    case "launchpad":
      return "Launchpad is the standalone local hub/runtime launcher released through the same channel model as the CLI. It is installed by users from public channel manifests rather than deployed to a site profile.";
    case "plus":
      return "Plus is the local desktop-style CoCalc product released through public channels and coordinated with tools-minimal. Promote Plus and tools-minimal together so installers see a compatible pair.";
    case "star":
      return "Star is the self-hosted CoCalc distribution published through immutable GitHub release assets and channel releases. The software command wraps build, promotion, history, rollback, and local smoke checks without moving Star distribution to R2.";
  }
}

function projectHostArtifactInfo({
  component,
  title,
  purpose,
  upgradeArtifact,
  notes,
}: {
  component: "project-host" | "container-runtime" | "project" | "tools";
  title: string;
  purpose: string;
  upgradeArtifact: "project-host" | "container-runtime" | "project" | "tools";
  notes: string[];
}): Omit<SoftwareComponentInfo, "description"> {
  return {
    component,
    title,
    status: "build-and-deploy",
    artifact_component: component,
    target_kind: "project-host-fleet",
    purpose,
    lifecycle: [
      "Build the package artifact.",
      "Publish host compatibility metadata.",
      `Run host upgrade --artifact ${upgradeArtifact} against online hosts.`,
      "Smoke a representative online host.",
    ],
    commands: {
      build: [`cocalc software build ${component} <tag>`],
      push: [`cocalc software push ${component} <tag-or-id>`],
      deploy: [`cocalc software deploy ${component}:<tag-or-id> <profile>`],
      smoke: [`cocalc software smoke ${component} <profile>`],
      history: [`cocalc software history ${component} <profile>`],
      rollback: [
        `cocalc software rollback ${component} <profile> <artifact-id>`,
      ],
    },
    related_components:
      component === "project-host"
        ? [
            "host-conat-router",
            "host-conat-persist",
            "host-acp-worker",
            "host-runtime-stack",
          ]
        : [],
    operator_notes: [
      ...notes,
      "Deploy affects online hosts and records history under the selected site profile.",
    ],
    agent_notes: [
      `Host upgrade artifact is ${upgradeArtifact}.`,
      "Smoke uses cocalc host list/status/rootfs style checks through the selected profile.",
    ],
    common_failure_modes: [
      "No online hosts are available for upgrade or smoke.",
      "A representative host reports stale artifact versions after deploy.",
    ],
  };
}

function releaseComponentInfo(
  component: "cli" | "launchpad" | "plus",
): Omit<SoftwareComponentInfo, "description"> {
  const product = releaseProductForArtifactComponent(component);
  const baseUrl = `https://software.cocalc.ai/software/${product}`;
  return {
    component,
    title:
      component === "cli"
        ? "CoCalc CLI"
        : component === "launchpad"
          ? "CoCalc Launchpad"
          : "CoCalc Plus",
    status: "build-and-deploy",
    artifact_component: component,
    target_kind: "release-channel",
    purpose:
      component === "plus"
        ? "Publish and promote CoCalc Plus release-channel installers, coordinated with tools-minimal."
        : `Publish and promote ${product} release-channel installers.`,
    lifecycle: [
      "Build an immutable SEA-style release artifact.",
      "Push to the R2 software artifact store.",
      "Deploy by promoting the artifact to dev, candidate, or stable.",
      "Smoke the public channel manifest and downloaded binary.",
    ],
    commands: {
      build: [`cocalc software build ${component} <tag>`],
      push: [`cocalc software push ${component} <tag-or-id>`],
      deploy:
        component === "plus"
          ? [
              "cocalc software deploy plus:<tag-or-id> <channel> --tools-minimal <tools-tag-or-id>",
            ]
          : [`cocalc software deploy ${component}:<tag-or-id> <channel>`],
      smoke: [`cocalc software smoke ${component} <channel>`],
      history: [`cocalc software history ${component} <channel>`],
      rollback: [
        `cocalc software rollback ${component} <channel> <artifact-id>`,
      ],
    },
    related_components: component === "plus" ? ["tools-minimal"] : [],
    operator_notes: [
      "Release channels are dev, candidate, and stable.",
      `Install script: ${baseUrl}/install.sh`,
      `Channel manifests: ${baseUrl}/dev-<os>-<arch>.json, ${baseUrl}/candidate-<os>-<arch>.json, ${baseUrl}/stable-<os>-<arch>.json`,
      ...(component === "plus"
        ? [
            "Plus promotion should move the plus artifact and tools-minimal artifact together.",
          ]
        : []),
    ],
    agent_notes: [
      "Channel deploy target is a release channel, not a site profile.",
      "Stable promotion also maintains the legacy latest alias where applicable.",
      ...(component === "plus"
        ? [
            "Resolve tools-minimal separately and include it in deployment details.",
          ]
        : []),
    ],
    common_failure_modes: [
      "Unsupported channel name; only dev, candidate, and stable are valid.",
      "Release channel manifest points at an artifact that no longer downloads or fails sha256.",
      ...(component === "plus"
        ? [
            "Missing coordinated tools-minimal artifact for the selected plus deploy.",
          ]
        : []),
    ],
  };
}

function formatSoftwareInfoPayload(
  payload: ReturnType<typeof softwareInfoPayload>,
): string {
  if (payload.component) {
    return formatSoftwareComponentInfo(payload.component);
  }
  const overview = payload.overview!;
  const lines = [
    "# cocalc software info",
    "",
    "CoCalc software manages immutable artifacts, R2 publication, site/profile deploys, release-channel promotion, smoke checks, deployment history, and rollback.",
    "",
    "Build/list/push components:",
    `  ${overview.build_components.join(", ")}`,
    "",
    "Deploy/smoke/history/rollback components:",
    `  ${overview.deploy_components.join(", ")}`,
    "",
    "Release channels:",
    `  ${overview.release_channels.join(", ")}`,
    "",
    "Site profiles:",
    `  ${overview.site_profile_source}`,
    "",
    "Component groups:",
  ];
  for (const [group, components] of Object.entries(overview.component_groups)) {
    lines.push(`  ${group}: ${components.join(", ")}`);
  }
  lines.push(
    "",
    "Examples:",
    "  cocalc software info hub",
    "  cocalc software build hub:<tag>",
    "  cocalc software deploy hub:<tag-or-id> <profile>",
    "  cocalc software smoke hub <profile>",
    "  cocalc software history hub <profile>",
    "  cocalc software rollback hub <profile> <artifact-id>",
    "",
    "Use --json for an agent-oriented component map.",
  );
  return lines.join("\n");
}

function formatSoftwareComponentInfo(info: SoftwareComponentInfo): string {
  const lines = [
    `# cocalc software info ${info.component}`,
    "",
    `${info.title} - ${info.description}`,
    "",
    info.purpose,
    "",
    "Lifecycle:",
    ...info.lifecycle.map((line) => `  - ${line}`),
    "",
    "Commands:",
  ];
  for (const [group, commands] of Object.entries(info.commands)) {
    if (!commands?.length) continue;
    lines.push(`  ${group}:`);
    for (const command of commands) {
      lines.push(`    ${command}`);
    }
  }
  if (info.related_components.length > 0) {
    lines.push("", `Related components: ${info.related_components.join(", ")}`);
  }
  lines.push(
    "",
    "Operator notes:",
    ...info.operator_notes.map((line) => `  - ${line}`),
    "",
    "Agent notes:",
    ...info.agent_notes.map((line) => `  - ${line}`),
    "",
    "Common failure modes:",
    ...info.common_failure_modes.map((line) => `  - ${line}`),
  );
  return lines.join("\n");
}

function runGitText(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout ?? ""}`.trim() || null;
}

async function defaultRunCommandOutput(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function defaultGitMetadata(cwd: string): SoftwareGitMetadata {
  const commit = runGitText(cwd, ["rev-parse", "HEAD"]);
  if (!commit) {
    throw new Error(`failed to resolve git commit in ${cwd}`);
  }
  const short =
    runGitText(cwd, ["rev-parse", "--short=12", "HEAD"]) ?? commit.slice(0, 12);
  const branch = runGitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGitText(cwd, ["status", "--porcelain"]) ?? "";
  return {
    commit,
    short,
    branch: branch && branch !== "HEAD" ? branch : null,
    dirty: status.trim().length > 0,
    status_porcelain: status,
  };
}

function defaultRepoRoot(cwd: string): string {
  const root = runGitText(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new Error(
      `software build must be run inside a cocalc-ai source git repository (cwd=${cwd})`,
    );
  }
  const srcRoot = join(root, "src");
  if (!existsSync(join(srcRoot, "packages", "pnpm-workspace.yaml"))) {
    throw new Error(
      `software build must be run inside a cocalc-ai source git repository; expected ${join(
        srcRoot,
        "packages",
        "pnpm-workspace.yaml",
      )}`,
    );
  }
  return root;
}

function resolveRepoLayout({
  cwd,
  deps,
}: {
  cwd: string;
  deps: Pick<SoftwareCommandDeps, "repoRoot">;
}): { repoRoot: string; srcRoot: string } {
  const repoRoot = resolve(deps.repoRoot?.(cwd) ?? defaultRepoRoot(cwd));
  const srcRoot = repoRoot.endsWith("/src") ? repoRoot : join(repoRoot, "src");
  return { repoRoot, srcRoot };
}

async function runDeployTypecheck(deps: SoftwareCommandDeps): Promise<void> {
  if (deps.deployPreflight) {
    await deps.deployPreflight();
    return;
  }
  if (!deps.runCommand) {
    throw new Error("software deploy typecheck requires runCommand dependency");
  }
  const cwd = resolve(deps.cwd ?? process.cwd());
  const { srcRoot } = resolveRepoLayout({ cwd, deps });
  const code = await deps.runCommand("pnpm", ["-C", srcRoot, "tsc"], {
    stdio: "inherit",
    env: deps.env ?? process.env,
  });
  if (code !== 0) {
    throw new Error(
      `software deploy typecheck failed with exit status ${code}`,
    );
  }
}

function rocketBuildInfo(component: SoftwareBuildComponent):
  | {
      script: string;
      kind: "bay-runtime" | "bay-hub" | "bay-static";
      artifactName: string;
    }
  | undefined {
  const nodeArch = process.arch === "arm64" ? "arm64" : "x64";
  if (component === "hub") {
    return {
      script: "build:bay-hub-bundle",
      kind: "bay-hub",
      artifactName: `cocalc-bay-hub-linux-${nodeArch}.tar.xz`,
    };
  }
  if (component === "bay") {
    return {
      script: "build:bay-bundle",
      kind: "bay-runtime",
      artifactName: `cocalc-bay-runtime-linux-${nodeArch}.tar.xz`,
    };
  }
  if (component === "static") {
    return {
      script: "build:bay-static-bundle",
      kind: "bay-static",
      artifactName: `cocalc-bay-static-linux-${nodeArch}.tar.xz`,
    };
  }
  return undefined;
}

function seaPlatformSuffix(): { machine: string; os: string } {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const machine =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64" && os === "linux"
        ? "aarch64"
        : process.arch;
  return { machine, os };
}

const CLI_RELEASE_FILE_SUFFIXES = [
  "x86_64-linux.tar.gz",
  "aarch64-linux.tar.gz",
  "arm64-darwin",
  "x86_64-windows.exe",
] as const;

function cliReleaseSourceFiles({
  directory,
  artifactId,
}: {
  directory: string;
  artifactId: string;
}): Array<{ source: string; name: string }> {
  return CLI_RELEASE_FILE_SUFFIXES.map((suffix) => {
    const name = `cocalc-cli-${artifactId}-${suffix}`;
    return { source: join(resolve(directory), name), name };
  });
}

function packageBuildInfo(
  component: SoftwareBuildComponent,
  artifactId: string,
):
  | {
      packageFilter: string;
      script: string;
      artifactName: string;
      artifactPath: (srcRoot: string) => string;
      env?: NodeJS.ProcessEnv;
      artifactFiles?: (srcRoot: string) => Array<{
        source: string;
        name: string;
      }>;
    }
  | undefined {
  if (component === "project-host") {
    return {
      packageFilter: "@cocalc/project-host",
      script: "build:bundle",
      artifactName: "bundle-linux.tar.xz",
      artifactPath: (srcRoot) =>
        join(
          srcRoot,
          "packages",
          "project-host",
          "build",
          "bundle-linux.tar.xz",
        ),
    };
  }
  if (component === "container-runtime") {
    const runtimeArch = process.arch === "arm64" ? "arm64" : "amd64";
    const artifactName = `container-runtime-linux-${runtimeArch}.tar.xz`;
    return {
      packageFilter: "@cocalc/backend",
      script: "build:container-runtime",
      artifactName,
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "backend", "podman", "build", artifactName),
    };
  }
  if (component === "project") {
    return {
      packageFilter: "@cocalc/project",
      script: "build:bundle",
      artifactName: "bundle-linux.tar.xz",
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "project", "build", "bundle-linux.tar.xz"),
    };
  }
  if (component === "tools") {
    const toolsArch = process.arch === "arm64" ? "arm64" : "amd64";
    const artifactName = `tools-linux-${toolsArch}.tar.xz`;
    return {
      packageFilter: "@cocalc/project",
      script: "build:tools",
      artifactName,
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "project", "build", artifactName),
      artifactFiles: (srcRoot) =>
        ["amd64", "arm64"].map((arch) => {
          const name = `tools-linux-${arch}.tar.xz`;
          return {
            name,
            source: join(srcRoot, "packages", "project", "build", name),
          };
        }),
    };
  }
  if (component === "tools-minimal") {
    const toolsArch = process.arch === "arm64" ? "arm64" : "amd64";
    const artifactName = `tools-minimal-linux-${toolsArch}.tar.xz`;
    return {
      packageFilter: "@cocalc/project",
      script: "build:tools-minimal",
      artifactName,
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "project", "build", artifactName),
      artifactFiles: (srcRoot) =>
        [
          ["linux", "amd64"],
          ["linux", "arm64"],
          ["darwin", "arm64"],
        ].map(([os, arch]) => {
          const name = `tools-minimal-${os}-${arch}.tar.xz`;
          return {
            name,
            source: join(srcRoot, "packages", "project", "build", name),
          };
        }),
    };
  }
  if (component === "cli") {
    const { machine, os } = seaPlatformSuffix();
    const artifactName = `cocalc-cli-${artifactId}-${machine}-${os}${
      os === "linux" ? ".tar.gz" : os === "windows" ? ".exe" : ""
    }`;
    return {
      packageFilter: "@cocalc/cli",
      script: "sea",
      artifactName,
      env: { COCALC_SOFTWARE_ARTIFACT_ID: artifactId },
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "cli", "build", "sea", artifactName),
    };
  }
  if (component === "launchpad") {
    const { machine, os } = seaPlatformSuffix();
    const artifactName = `cocalc-launchpad-${artifactId}-${machine}-${os}.tar.xz`;
    return {
      packageFilter: "@cocalc/launchpad",
      script: "sea",
      artifactName,
      env: { COCALC_SOFTWARE_ARTIFACT_ID: artifactId },
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "launchpad", "build", "sea", artifactName),
    };
  }
  if (component === "plus") {
    const { machine, os } = seaPlatformSuffix();
    const artifactName = `cocalc-plus-${artifactId}-${machine}-${os}`;
    return {
      packageFilter: "@cocalc/plus",
      script: "sea",
      artifactName,
      env: { COCALC_SOFTWARE_ARTIFACT_ID: artifactId },
      artifactPath: (srcRoot) =>
        join(srcRoot, "packages", "plus", "build", "sea", artifactName),
    };
  }
  return undefined;
}

function hostBootstrapBuildInfo(component: SoftwareBuildComponent):
  | {
      artifactName: "bootstrap.py";
      source: (srcRoot: string) => string;
    }
  | undefined {
  if (component !== "host-bootstrap") {
    return undefined;
  }
  return {
    artifactName: "bootstrap.py",
    source: (srcRoot) =>
      join(srcRoot, "packages", "server", "cloud", "bootstrap", "bootstrap.py"),
  };
}

async function listStarReleaseFiles(
  outputDir: string,
): Promise<Array<{ source: string; name: string }>> {
  const entries = await readdir(outputDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      name: entry.name,
      source: join(outputDir, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parseLimit(raw: string | undefined): number {
  if (raw == null || raw.trim() === "") {
    return 10;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return value;
}

function parseTimeoutMs(raw: string | undefined, option = "--timeout"): number {
  const value = raw == null || raw.trim() === "" ? 30_000 : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${option} must be a positive number of milliseconds`);
  }
  return Math.max(1, Math.floor(value));
}

function resolveSmokeTimeoutMs({
  opts,
  command,
}: {
  opts: SmokeOptions;
  command: Command;
}): number {
  if (opts.checkTimeoutMs != null || opts.timeout != null) {
    return parseTimeoutMs(
      opts.checkTimeoutMs ?? opts.timeout,
      "--check-timeout-ms",
    );
  }
  const globals = command.optsWithGlobals() as { timeout?: unknown };
  const globalTimeout = `${globals.timeout ?? ""}`.trim();
  if (globalTimeout && /^\d+$/.test(globalTimeout)) {
    return parseTimeoutMs(globalTimeout, "--check-timeout-ms");
  }
  return parseTimeoutMs(undefined, "--check-timeout-ms");
}

function smokeRpcTimeout(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function releaseArtifactDownloadTimeoutMs({
  checkTimeoutMs,
  sizeBytes,
}: {
  checkTimeoutMs: number;
  sizeBytes: unknown;
}): number {
  const parsedSizeBytes = Number(sizeBytes);
  const sizeBudgetMs =
    Number.isFinite(parsedSizeBytes) && parsedSizeBytes > 0
      ? Math.ceil(parsedSizeBytes / (1024 * 1024)) * 1000 + 30_000
      : 60_000;
  return Math.max(
    checkTimeoutMs,
    Math.min(15 * 60_000, Math.max(60_000, sizeBudgetMs)),
  );
}

function formatDurationMs(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value}ms`;
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

function appendUrlPath(base: string, path: string): string {
  const url = new URL(base);
  const basePath = url.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${suffix}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function runTimedSmokeCheck(
  check: string,
  fn: () => Promise<string>,
  deps: Pick<SoftwareCommandDeps, "now">,
): Promise<SoftwareSmokeCheck> {
  const startedAt = deps.now?.() ?? new Date();
  try {
    const detail = await fn();
    return {
      check,
      status: "ok",
      detail,
      duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
    };
  } catch (err) {
    return {
      check,
      status: "failed",
      detail: err instanceof Error ? err.message : `${err}`,
      duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
    };
  }
}

async function fetchSmokeUrl({
  url,
  timeoutMs,
  deps,
  method = "GET",
}: {
  url: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
  method?: "GET" | "HEAD";
}): Promise<string> {
  const smokeFetch = deps.fetch ?? globalThis.fetch;
  if (!smokeFetch) {
    throw new Error("software smoke requires fetch support");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await smokeFetch(url, {
      method,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${method} ${url} returned HTTP ${response.status}`);
    }
    return `HTTP ${response.status}`;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type FrontendAssetHistory = {
  schema: 1;
  builds: { assets?: unknown }[];
};

function frontendAssetsFromHistory(value: unknown): string[] {
  const history = value as FrontendAssetHistory;
  if (history?.schema !== 1 || !Array.isArray(history.builds)) {
    throw new Error("frontend asset history has an unsupported schema");
  }
  if (history.builds.length < 1 || history.builds.length > 2) {
    throw new Error("frontend asset history must contain one or two builds");
  }
  const assets = new Set<string>();
  for (const build of history.builds) {
    if (!Array.isArray(build?.assets) || build.assets.length === 0) {
      throw new Error("frontend asset history contains an empty build");
    }
    for (const value of build.assets) {
      const asset = `${value ?? ""}`.replace(/\\/g, "/");
      if (
        !asset ||
        asset.startsWith("/") ||
        asset.split("/").includes("..") ||
        !/(?:^|[-.])[0-9a-f]{16,}(?=[-.]|$)/i.test(
          asset.slice(asset.lastIndexOf("/") + 1),
        )
      ) {
        throw new Error(
          `frontend asset history contains unsafe path: ${asset}`,
        );
      }
      assets.add(asset);
      if (assets.size > 10_000) {
        throw new Error("frontend asset history exceeds 10000 files");
      }
    }
  }
  return [...assets];
}

async function smokeFrontendAssetHistory({
  api,
  timeoutMs,
  deps,
}: {
  api: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<string> {
  const smokeFetch = deps.fetch ?? globalThis.fetch;
  if (!smokeFetch) {
    throw new Error("software smoke requires fetch support");
  }
  const historyUrl = appendUrlPath(api, "/static/frontend-build-history.json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await smokeFetch(historyUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET ${historyUrl} returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
  const assets = frontendAssetsFromHistory(await response.json());
  const failures: string[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(20, assets.length) },
    async () => {
      while (next < assets.length) {
        const asset = assets[next++];
        const url = appendUrlPath(api, `/static/${asset}`);
        try {
          await fetchSmokeUrl({ url, timeoutMs, deps, method: "HEAD" });
        } catch {
          try {
            await fetchSmokeUrl({ url, timeoutMs, deps, method: "HEAD" });
          } catch (err) {
            failures.push(
              `${asset}: ${err instanceof Error ? err.message : `${err}`}`,
            );
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (failures.length) {
    throw new Error(
      `${failures.length}/${assets.length} retained frontend assets failed: ${failures.slice(0, 5).join("; ")}`,
    );
  }
  return `${assets.length} current/previous content-addressed assets returned HTTP 200`;
}

async function smokeHttpChecks({
  api,
  timeoutMs,
  deps,
  checkFrontendAssets = false,
}: {
  api: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
  checkFrontendAssets?: boolean;
}): Promise<SoftwareSmokeCheck[]> {
  const checks: SoftwareSmokeCheck[] = [];
  for (const [check, path] of [
    ["homepage", "/"],
    ["static app shell", "/static/app.html"],
    [
      "email auth link shell",
      "/auth/email/continue/00000000-0000-4000-8000-000000000000",
    ],
    ["webapp favicon", "/webapp/favicon.ico"],
    ["managed compute VM setup", "/project-host/compute-vm-setup.sh"],
    ["PDF.js Japanese CMap", "/cdn/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap"],
  ] as const) {
    checks.push(
      await runTimedSmokeCheck(
        check,
        async () =>
          await fetchSmokeUrl({
            url: appendUrlPath(api, path),
            timeoutMs,
            deps,
          }),
        deps,
      ),
    );
  }
  if (checkFrontendAssets) {
    checks.push(
      await runTimedSmokeCheck(
        "current and previous frontend assets",
        async () => await smokeFrontendAssetHistory({ api, timeoutMs, deps }),
        deps,
      ),
    );
  }
  return checks;
}

function assertSmokeChecks(checks: SoftwareSmokeCheck[]): void {
  const failures = checks.filter((check) => check.status !== "ok");
  if (!failures.length) return;
  throw new Error(
    `software smoke failed: ${failures
      .map((failure) => `${failure.check}: ${failure.detail}`)
      .join("; ")}`,
  );
}

function parseCommandJsonOutput({
  command,
  stdout,
}: {
  command: string;
  stdout: string;
}): any {
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.ok === false) {
      throw new Error(parsed?.error?.message ?? `${command} failed`);
    }
    return parsed?.data;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${command} returned invalid JSON`);
    }
    throw err;
  }
}

async function runCliJson({
  args,
  deps,
}: {
  args: string[];
  deps: SoftwareCommandDeps;
}): Promise<any> {
  const cli = currentCliInvocation();
  const runCommandOutput = deps.runCommandOutput ?? defaultRunCommandOutput;
  const result = await runCommandOutput(cli.command, [...cli.args, ...args], {
    env: deps.env ?? process.env,
  });
  if (result.code !== 0) {
    throw new Error(
      `${args.join(" ")} failed with exit status ${result.code}: ${
        result.stderr.trim() || result.stdout.trim() || "no output"
      }`,
    );
  }
  return parseCommandJsonOutput({
    command: args.join(" "),
    stdout: result.stdout,
  });
}

function hostArtifactForSmoke(
  component: SoftwareDeployComponent,
): string | undefined {
  if (component === "project-host") return "project-host";
  if (component === "container-runtime") return "container-runtime";
  if (component === "project") return "project-bundle";
  if (component === "tools") return "tools";
  return undefined;
}

function runtimeArtifactForHostUpgradeArtifact(
  artifact: "project-host" | "container-runtime" | "project" | "tools",
): "project-host" | "container-runtime" | "project-bundle" | "tools" {
  return artifact === "project" ? "project-bundle" : artifact;
}

function isStarSmokeComponent(component: SoftwareDeployComponent): boolean {
  return component === "star";
}

function isHostBootstrapSmokeComponent(
  component: SoftwareDeployComponent,
): boolean {
  return component === "host-bootstrap";
}

async function smokeHostBootstrapChecks({
  timeoutMs,
  deps,
}: {
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareSmokeCheck[]> {
  const baseUrl = softwarePublicBaseUrl(deps);
  const bootstrapUrl = `${baseUrl}/software/bootstrap/latest/bootstrap.py`;
  return [
    await runTimedSmokeCheck(
      "host bootstrap.py",
      async () => await fetchSmokeUrl({ url: bootstrapUrl, timeoutMs, deps }),
      deps,
    ),
    await runTimedSmokeCheck(
      "host bootstrap.py sha256",
      async () =>
        await fetchSmokeUrl({
          url: `${bootstrapUrl}.sha256`,
          timeoutMs,
          deps,
        }),
      deps,
    ),
  ];
}

async function smokeStarChecks({
  channel,
  deps,
}: {
  channel: string;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareSmokeCheck[]> {
  const releaseChannel = validateSoftwareReleaseChannel(channel);
  if (!deps.runCommand) {
    throw new Error("software smoke star requires runCommand dependency");
  }
  const cwd = resolve(deps.cwd ?? process.cwd());
  const { srcRoot } = resolveRepoLayout({ cwd, deps });
  const script = join(srcRoot, "scripts", "star", "smoke-star.sh");
  return [
    await runTimedSmokeCheck(
      "star smoke script",
      async () => {
        const code = await deps.runCommand!(script, [], {
          stdio: "inherit",
          env: {
            ...(deps.env ?? process.env),
            SRC_ROOT: srcRoot,
            COCALC_STAR_CHANNEL: releaseChannel,
            COCALC_STAR_RELEASE_CHANNEL: releaseChannel,
          },
        });
        if (code !== 0) {
          throw new Error(`star smoke script failed with exit status ${code}`);
        }
        return `smoke-star.sh ok channel=${releaseChannel}`;
      },
      deps,
    ),
  ];
}

function selectRepresentativeHost(rows: any[], requestedHost?: string): any {
  const requested = `${requestedHost ?? ""}`.trim();
  const candidates = Array.isArray(rows) ? rows : [];
  const match = requested
    ? candidates.find(
        (row) => row.host_id === requested || row.name === requested,
      )
    : candidates.find((row) =>
        ["running", "active"].includes(`${row.status ?? ""}`.trim()),
      );
  if (!match) {
    throw new Error(
      requested
        ? `host not found or not listed: ${requested}`
        : "no running project host found for smoke test",
    );
  }
  const status = `${match.status ?? ""}`.trim();
  if (!["running", "active"].includes(status)) {
    throw new Error(
      `representative host ${match.host_id ?? match.name} is not running: ${status}`,
    );
  }
  return match;
}

function validateHostDeploymentStatus({
  status,
  component,
}: {
  status: any;
  component: SoftwareDeployComponent;
}): string {
  if (`${status?.observation_error ?? ""}`.trim()) {
    throw new Error(
      `host runtime observation error: ${status.observation_error}`,
    );
  }
  const artifact = hostArtifactForSmoke(component);
  if (!artifact) {
    throw new Error(`software smoke ${component} has no host artifact mapping`);
  }
  const observedArtifact = (status?.observed_artifacts ?? []).find(
    (entry: any) => entry?.artifact === artifact,
  );
  if (!observedArtifact?.current_version) {
    throw new Error(`host is missing observed ${artifact} current_version`);
  }
  if (component === "project-host") {
    const projectHost = (status?.observed_components ?? []).find(
      (entry: any) => entry?.component === "project-host",
    );
    if (!projectHost) {
      throw new Error("host is missing observed project-host component");
    }
    if (projectHost.runtime_state !== "running") {
      throw new Error(
        `project-host runtime_state is ${projectHost.runtime_state ?? "unknown"}`,
      );
    }
    if (
      projectHost.version_state &&
      !["aligned", "newer"].includes(projectHost.version_state)
    ) {
      throw new Error(
        `project-host version_state is ${projectHost.version_state}`,
      );
    }
    const rollout = status?.observed_host_agent?.project_host?.rollout;
    if (rollout && rollout.healthy === false) {
      throw new Error("project-host rollout is unhealthy");
    }
  }
  return `${artifact} current_version=${observedArtifact.current_version}`;
}

async function smokeHostSoftwareChecks({
  component,
  profile,
  host,
  deps,
}: {
  component: SoftwareDeployComponent;
  profile: string;
  host?: string;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareSmokeCheck[]> {
  const checks: SoftwareSmokeCheck[] = [];
  let selectedHost: any;
  checks.push(
    await runTimedSmokeCheck(
      "representative host",
      async () => {
        const data = await runCliJson({
          args: [
            "--profile",
            profile,
            "--output",
            "json",
            "host",
            "list",
            "--limit",
            host ? "500" : "50",
          ],
          deps,
        });
        selectedHost = selectRepresentativeHost(data, host);
        return `${selectedHost.name ?? selectedHost.host_id} (${selectedHost.host_id})`;
      },
      deps,
    ),
  );
  if (!selectedHost) return checks;

  checks.push(
    await runTimedSmokeCheck(
      "host deploy status",
      async () => {
        const status = await runCliJson({
          args: [
            "--profile",
            profile,
            "--output",
            "json",
            "host",
            "deploy",
            "status",
            selectedHost.host_id,
          ],
          deps,
        });
        return validateHostDeploymentStatus({ status, component });
      },
      deps,
    ),
  );

  checks.push(
    await runTimedSmokeCheck(
      "host rootfs rpc",
      async () => {
        const data = await runCliJson({
          args: [
            "--profile",
            profile,
            "--output",
            "json",
            "host",
            "rootfs",
            selectedHost.host_id,
          ],
          deps,
        });
        return `cached_rootfs=${data?.summary?.total ?? 0}`;
      },
      deps,
    ),
  );
  return checks;
}

function releaseSmokeTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: "cli" | "launchpad" | "plus";
      binaryName: "cocalc" | "cocalc.exe" | "cocalc-launchpad" | "cocalc-plus";
    }
  | undefined {
  if (component === "cli") {
    return {
      artifactComponent: "cli",
      binaryName: process.platform === "win32" ? "cocalc.exe" : "cocalc",
    };
  }
  if (component === "launchpad") {
    return { artifactComponent: "launchpad", binaryName: "cocalc-launchpad" };
  }
  if (component === "plus") {
    return { artifactComponent: "plus", binaryName: "cocalc-plus" };
  }
  return undefined;
}

function softwarePublicBaseUrl(deps: SoftwareCommandDeps): string {
  const env = deps.env ?? process.env;
  return `${
    env.COCALC_SOFTWARE_PUBLIC_BASE_URL ||
    env.COCALC_R2_PUBLIC_BASE_URL ||
    "https://software.cocalc.ai"
  }`.replace(/\/+$/, "");
}

function currentReleasePlatform(): {
  os: "linux" | "darwin" | "windows";
  arch: "amd64" | "arm64";
} {
  const os = process.platform === "win32" ? "windows" : process.platform;
  if (os !== "linux" && os !== "darwin" && os !== "windows") {
    throw new Error(`unsupported release smoke OS: ${process.platform}`);
  }
  const arch =
    process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  if (arch !== "amd64" && arch !== "arm64") {
    throw new Error(`unsupported release smoke architecture: ${process.arch}`);
  }
  if (os === "windows" && arch !== "amd64") {
    throw new Error("Windows CLI release smoke currently supports amd64 only");
  }
  return { os, arch };
}

function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchSmokeBuffer({
  url,
  timeoutMs,
  deps,
}: {
  url: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<Buffer> {
  const smokeFetch = deps.fetch ?? globalThis.fetch;
  if (!smokeFetch) {
    throw new Error("software smoke requires fetch support");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await smokeFetch(url, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET ${url} returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`GET ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSmokeJson({
  url,
  timeoutMs,
  deps,
}: {
  url: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<any> {
  const body = await fetchSmokeBuffer({ url, timeoutMs, deps });
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error(`GET ${url} returned invalid JSON`);
  }
}

function validateReleaseChannelManifest({
  manifest,
  component,
  channel,
  platform,
}: {
  manifest: any;
  component: "cli" | "launchpad" | "plus";
  channel: string;
  platform: {
    os: "linux" | "darwin" | "windows";
    arch: "amd64" | "arm64";
  };
}): void {
  if (manifest?.schema !== "cocalc-software-release-channel-v1") {
    throw new Error("invalid release channel manifest schema");
  }
  if (manifest.component !== component) {
    throw new Error(
      `release channel manifest component mismatch: ${manifest.component}`,
    );
  }
  if (manifest.channel !== channel) {
    throw new Error(
      `release channel manifest channel mismatch: ${manifest.channel}`,
    );
  }
  if (manifest.os !== platform.os || manifest.arch !== platform.arch) {
    throw new Error(
      `release channel manifest platform mismatch: ${manifest.os}/${manifest.arch}`,
    );
  }
  if (!manifest.url || !manifest.sha256 || !manifest.artifact_id) {
    throw new Error(
      "release channel manifest missing url, sha256, or artifact_id",
    );
  }
}

async function materializeReleaseExecutable({
  component,
  binaryName,
  artifactPath,
  artifactUrl,
  workDir,
  deps,
}: {
  component: "cli" | "launchpad" | "plus";
  binaryName: string;
  artifactPath: string;
  artifactUrl: string;
  workDir: string;
  deps: SoftwareCommandDeps;
}): Promise<string> {
  if (
    component === "launchpad" ||
    artifactUrl.endsWith(".tar.xz") ||
    artifactUrl.endsWith(".tar.gz") ||
    artifactUrl.endsWith(".tgz")
  ) {
    const extractDir = join(workDir, "extract");
    await mkdir(extractDir, { recursive: true });
    const runCommandOutput = deps.runCommandOutput ?? defaultRunCommandOutput;
    const compressedWithGzip =
      artifactUrl.endsWith(".tar.gz") || artifactUrl.endsWith(".tgz");
    const result = await runCommandOutput(
      "tar",
      ["-C", extractDir, compressedWithGzip ? "-xzf" : "-Jxf", artifactPath],
      {},
    );
    if (result.code !== 0) {
      throw new Error(
        `tar extraction failed with exit status ${result.code}: ${
          result.stderr.trim() || result.stdout.trim() || "no output"
        }`,
      );
    }
    const executable = await findExecutableByName(extractDir, binaryName);
    if (!executable) {
      throw new Error(`artifact did not contain executable ${binaryName}`);
    }
    return executable;
  }
  const executablePath = join(workDir, binaryName);
  if (artifactUrl.endsWith(".xz")) {
    const result = spawnSync("xz", ["-dc", artifactPath], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 512,
    });
    if (result.status !== 0) {
      throw new Error(
        `xz decompression failed with exit status ${result.status}: ${
          result.stderr?.toString("utf8").trim() || "no output"
        }`,
      );
    }
    await writeFile(executablePath, result.stdout);
  } else {
    await copyFile(artifactPath, executablePath);
  }
  if (process.platform !== "win32") await chmod(executablePath, 0o755);
  return executablePath;
}

async function findExecutableByName(
  dir: string,
  name: string,
): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutableByName(path, name);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && entry.name === name) {
      if (process.platform !== "win32") await chmod(path, 0o755);
      return path;
    }
  }
  return undefined;
}

async function smokeReleaseChannelChecks({
  component,
  channel,
  timeoutMs,
  deps,
}: {
  component: SoftwareDeployComponent;
  channel: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareSmokeCheck[]> {
  const target = releaseSmokeTargetForComponent(component);
  if (!target) return [];
  const releaseChannel = validateSoftwareReleaseChannel(channel);
  const platform = currentReleasePlatform();
  const baseUrl = softwarePublicBaseUrl(deps);
  const product = releaseProductForArtifactComponent(target.artifactComponent);
  const manifestUrl = `${baseUrl}/software/${product}/${releaseChannel}-${platform.os}-${platform.arch}.json`;
  let manifest: any;
  let artifactPath = "";
  let workDir = "";
  const checks: SoftwareSmokeCheck[] = [];

  checks.push(
    await runTimedSmokeCheck(
      "release channel manifest",
      async () => {
        manifest = await fetchSmokeJson({ url: manifestUrl, timeoutMs, deps });
        validateReleaseChannelManifest({
          manifest,
          component: target.artifactComponent,
          channel: releaseChannel,
          platform,
        });
        return `${manifest.artifact_id} ${manifest.url}`;
      },
      deps,
    ),
  );
  if (!manifest) return checks;

  const downloadCheck = await runTimedSmokeCheck(
    "download artifact",
    async () => {
      workDir = await mkdtemp(join(tmpdir(), "cocalc-software-smoke-"));
      const candidatePath = join(workDir, manifest.filename || "artifact");
      const body = await fetchSmokeBuffer({
        url: manifest.url,
        timeoutMs: releaseArtifactDownloadTimeoutMs({
          checkTimeoutMs: timeoutMs,
          sizeBytes: manifest.size_bytes,
        }),
        deps,
      });
      const sha256 = sha256Buffer(body);
      if (sha256 !== manifest.sha256) {
        throw new Error(
          `artifact sha256 mismatch: expected ${manifest.sha256}, got ${sha256}`,
        );
      }
      await writeFile(candidatePath, body);
      artifactPath = candidatePath;
      return `${humanSize(body.length)} sha256:${sha256}`;
    },
    deps,
  );
  checks.push(downloadCheck);
  if (downloadCheck.status !== "ok" || !artifactPath || !workDir) {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
    return checks;
  }

  checks.push(
    await runTimedSmokeCheck(
      "run version",
      async () => {
        try {
          const executable = await materializeReleaseExecutable({
            component: target.artifactComponent,
            binaryName: target.binaryName,
            artifactPath,
            artifactUrl: manifest.url,
            workDir,
            deps,
          });
          const runCommandOutput =
            deps.runCommandOutput ?? defaultRunCommandOutput;
          const runEnv = {
            ...(deps.env ?? process.env),
            ...releaseSmokeVersionEnv({
              component: target.artifactComponent,
              manifest,
            }),
          };
          const privateLibDir = join(dirname(executable), "lib");
          if (existsSync(privateLibDir)) {
            runEnv.LD_LIBRARY_PATH = [privateLibDir, runEnv.LD_LIBRARY_PATH]
              .filter(Boolean)
              .join(":");
          }
          const result = await runCommandOutput(executable, ["--version"], {
            env: runEnv,
          });
          if (result.code !== 0) {
            throw new Error(
              `${target.binaryName} --version failed with exit status ${result.code}: ${
                result.stderr.trim() || result.stdout.trim() || "no output"
              }`,
            );
          }
          const output = result.stdout.trim();
          if (!output.includes(manifest.artifact_id)) {
            throw new Error(
              `${target.binaryName} --version did not include artifact id ${manifest.artifact_id}: ${output}`,
            );
          }
          return output;
        } finally {
          if (workDir) {
            await rm(workDir, { recursive: true, force: true });
          }
        }
      },
      deps,
    ),
  );
  return checks;
}

function releaseSmokeVersionEnv({
  component,
  manifest,
}: {
  component: "cli" | "launchpad" | "plus";
  manifest: any;
}): Record<string, string> {
  const prefix =
    component === "cli"
      ? "COCALC_CLI"
      : component === "launchpad"
        ? "COCALC_LAUNCHPAD"
        : "COCALC_PLUS";
  return {
    [`${prefix}_VERSION`]: `${manifest.version ?? manifest.artifact_id}`,
    [`${prefix}_ARTIFACT_ID`]: `${manifest.artifact_id}`,
    [`${prefix}_PUBLISHED_AT`]: `${manifest.published_at ?? ""}`,
    [`${prefix}_GIT_COMMIT`]: `${manifest.git?.commit ?? ""}`,
    [`${prefix}_GIT_SHORT`]: `${manifest.git?.short ?? ""}`,
  };
}

function deploymentStatusForDisplay(
  status: SoftwareDeploymentIndexEntry["status"],
): string {
  return status === "started" ? "unknown" : status;
}

function formatDeployedBy(
  deployedBy: SoftwareDeploymentIndexEntry["deployed_by"],
): string {
  return (
    deployedBy.email_address ||
    deployedBy.account_id ||
    deployedBy.user ||
    "unknown"
  );
}

function formatDeployTarget(
  target: SoftwareDeploymentIndexEntry["target"],
): string {
  if (target.profile) {
    return `${target.kind}:${target.profile}`;
  }
  if (target.channel) {
    return `${target.kind}:${target.channel}`;
  }
  return target.kind;
}

function deploymentHistoryRow(
  entry: SoftwareDeploymentIndexEntry,
): SoftwareDeploymentHistoryRow {
  return {
    deployed_at: entry.started_at,
    component: entry.component,
    profile_or_channel: entry.profile_or_channel,
    artifact_id: entry.artifact_id,
    tag: entry.tag,
    git: entry.git.short,
    dirty: entry.git.dirty,
    deployed_by: formatDeployedBy(entry.deployed_by),
    target: formatDeployTarget(entry.target),
    status: deploymentStatusForDisplay(entry.status),
    duration:
      entry.duration_ms == null
        ? undefined
        : formatDurationMs(entry.duration_ms),
    error: entry.error,
    record: entry.record_url,
  };
}

function narrowDeploymentHistoryRow(row: SoftwareDeploymentHistoryRow) {
  return {
    deployed_at: row.deployed_at,
    tag: row.tag,
    git: row.git,
    deployed_by: row.deployed_by,
    status: row.status,
  };
}

async function readDeploymentRecordByKey({
  client,
  config,
  key,
}: {
  client: SoftwareR2Client;
  config: Awaited<ReturnType<typeof resolveSoftwareRemoteConfig>>;
  key: string;
}): Promise<SoftwareDeploymentRecord> {
  const body = await client.getR2ObjectBuffer({
    auth: config.auth,
    key,
  });
  if (!body) {
    throw new Error(`software deployment record is missing: ${key}`);
  }
  const record = JSON.parse(body.toString("utf8"));
  if (record?.schema !== "cocalc-software-deployment-v1") {
    throw new Error(`invalid software deployment record: ${key}`);
  }
  return record;
}

function successfulRollbackTarget({
  index,
  artifactId,
}: {
  index: Awaited<ReturnType<typeof readDeploymentIndex>>;
  artifactId: string;
}): SoftwareDeploymentIndexEntry {
  const matches = index.deployments.filter(
    (entry) => entry.artifact_id === artifactId,
  );
  const succeeded = matches.find((entry) => entry.status === "succeeded");
  if (succeeded) {
    return succeeded;
  }
  if (matches.length) {
    throw new Error(
      `software rollback target ${artifactId} exists in history but has no succeeded deployment`,
    );
  }
  throw new Error(
    `software rollback target ${artifactId} was not found in deployment history for ${index.component}/${index.profile_or_channel}`,
  );
}

function toolsMinimalArtifactIdFromRecord(
  record: SoftwareDeploymentRecord,
): string | undefined {
  const details = record.details as any;
  const value = `${details?.tools_minimal?.artifact_id ?? ""}`.trim();
  return value || undefined;
}

function rollbackDeployArgs({
  cliArgs,
  component,
  artifactId,
  profileOrChannel,
  opts,
  record,
}: {
  cliArgs: string[];
  component: SoftwareDeployComponent;
  artifactId: string;
  profileOrChannel: string;
  opts: RollbackOptions;
  record: SoftwareDeploymentRecord;
}): string[] {
  const args = [
    ...cliArgs,
    "--quiet",
    "software",
    "deploy",
    component,
    artifactId,
    profileOrChannel,
  ];
  if (opts.localStore) args.push("--local-store", opts.localStore);
  if (opts.config) args.push("--config", opts.config);
  if (opts.remote) args.push("--remote", opts.remote);
  if (opts.api) args.push("--api", opts.api);
  if (opts.envFile) args.push("--env-file", opts.envFile);
  if (component === "host-bootstrap") {
    const bootstrapScope = parseHostBootstrapScope(opts.bootstrapScope);
    const bootstrapPublishChannel = parseHostBootstrapPublishChannel(
      opts.bootstrapPublishChannel,
    );
    if (opts.rollout && !bootstrapScope) {
      throw new Error(
        "software rollback host-bootstrap --rollout requires --bootstrap-scope full, helpers, or environment",
      );
    }
    if (!opts.rollout && bootstrapScope) {
      throw new Error(
        "software rollback host-bootstrap --bootstrap-scope requires --rollout",
      );
    }
    if (opts.rollout) {
      args.push("--rollout", "--bootstrap-scope", bootstrapScope!);
    }
    if (bootstrapPublishChannel) {
      args.push("--bootstrap-publish-channel", bootstrapPublishChannel);
    }
  }
  if (component === "plus") {
    const toolsMinimal =
      opts.toolsMinimal || toolsMinimalArtifactIdFromRecord(record);
    if (!toolsMinimal) {
      throw new Error(
        `software rollback plus requires historical tools-minimal artifact metadata or --tools-minimal <tag-or-id>`,
      );
    }
    args.push("--tools-minimal", toolsMinimal);
  }
  return args;
}

function elapsedMsSince(
  startedAt: Date,
  deps: Pick<SoftwareCommandDeps, "now">,
): number {
  return Math.max(
    0,
    (deps.now?.() ?? new Date()).getTime() - startedAt.getTime(),
  );
}

async function localTagExists({
  manifests,
  tag,
}: {
  manifests: Awaited<ReturnType<typeof listLocalManifests>>;
  tag: string;
}): Promise<boolean> {
  return manifests.some(({ manifest }) => manifest.tag === tag);
}

function localArtifactIdExists({
  manifests,
  artifactId,
}: {
  manifests: Awaited<ReturnType<typeof listLocalManifests>>;
  artifactId: string;
}): boolean {
  return manifests.some(({ manifest }) => manifest.artifact_id === artifactId);
}

async function buildFromFile({
  component,
  tagArg,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  tagArg: string | undefined;
  opts: BuildOptions;
  deps: Required<Pick<SoftwareCommandDeps, "env" | "now">> &
    Pick<
      SoftwareCommandDeps,
      "cwd" | "gitMetadata" | "repoRoot" | "runCommand"
    >;
}): Promise<SoftwareArtifactManifest & { local_dir: string }> {
  const cwd = resolve(deps.cwd ?? process.cwd());
  const { repoRoot, srcRoot } = resolveRepoLayout({ cwd, deps });
  const localStore = resolveSoftwareLocalStore({
    option: opts.localStore,
    env: deps.env,
  });
  const createdAt = deps.now();
  const git = deps.gitMetadata?.(repoRoot) ?? defaultGitMetadata(repoRoot);
  const existingManifests = await listLocalManifests({ localStore, component });
  const tagGenerated = tagArg == null || tagArg.trim() === "";
  const tag = tagGenerated
    ? chooseGeneratedTag({
        createdAt,
        tagExists: (candidate) =>
          existingManifests.some(({ manifest }) => manifest.tag === candidate),
      })
    : validateSoftwareTag(tagArg);
  if (
    tagGenerated &&
    (await localTagExists({ manifests: existingManifests, tag }))
  ) {
    throw new Error(`generated software tag already exists locally: ${tag}`);
  }
  const startedAt = createdAt;
  const generatedArtifactId = createSoftwareArtifactId({
    createdAt,
    git,
    tag,
  });
  const artifactId = opts.artifactId
    ? validateSoftwareArtifactId(opts.artifactId)
    : generatedArtifactId;
  if (opts.artifactId) {
    const git8 = git.short.slice(0, 8) || git.commit.slice(0, 8);
    const expectedSuffix = `-${git8}-${tag}${git.dirty ? "-dirty" : ""}`;
    if (!artifactId.endsWith(expectedSuffix)) {
      throw new Error(
        `explicit software artifact id must end with ${expectedSuffix}`,
      );
    }
  }
  if (
    localArtifactIdExists({
      manifests: existingManifests,
      artifactId,
    })
  ) {
    throw new Error(
      `software artifact id already exists locally for ${component}: ${artifactId}`,
    );
  }
  let buildTempDir: string | undefined;
  let sourceFile = opts.fromFile;
  let artifactName = opts.artifactName;
  let sourceFiles:
    | Array<{
        source: string;
        name?: string;
      }>
    | undefined;
  let commandText = `cocalc software build ${component}${
    tagArg ? `:${tagArg}` : ""
  }`;
  if (opts.fromFile && opts.fromDirectory) {
    throw new Error(
      "software build accepts only one of --from-file or --from-directory",
    );
  }
  if (opts.fromDirectory) {
    if (component !== "cli") {
      throw new Error(
        "--from-directory is currently supported only for cli releases",
      );
    }
    if (!opts.artifactId) {
      throw new Error(
        "software build cli --from-directory requires --artifact-id",
      );
    }
    if (opts.artifactName) {
      throw new Error("--artifact-name cannot be used with --from-directory");
    }
    sourceFiles = cliReleaseSourceFiles({
      directory: opts.fromDirectory,
      artifactId,
    });
    commandText = `record CLI release directory ${resolve(opts.fromDirectory)}`;
  }
  if (sourceFile) {
    sourceFiles = [{ source: sourceFile, name: artifactName }];
  }
  if (!sourceFile && !sourceFiles) {
    const info = rocketBuildInfo(component);
    const packageInfo = packageBuildInfo(component, artifactId);
    const bootstrapInfo = hostBootstrapBuildInfo(component);
    const starInfo =
      component === "star"
        ? {
            script: join(
              srcRoot,
              "scripts",
              "star",
              "build-github-release-assets.sh",
            ),
          }
        : undefined;
    if (bootstrapInfo) {
      sourceFile = bootstrapInfo.source(srcRoot);
      artifactName = bootstrapInfo.artifactName;
      sourceFiles = [{ source: sourceFile, name: artifactName }];
      commandText = `record ${sourceFile}`;
    } else {
      if (!info && !packageInfo && !starInfo) {
        throw new Error(
          `software build ${component} is not wired yet; use --from-file <path> to create a local artifact manifest from an existing file`,
        );
      }
      if (!deps.runCommand) {
        throw new Error("software build requires runCommand dependency");
      }
      let command = "pnpm";
      let commandEnv = deps.env;
      let args: string[];
      if (packageInfo) {
        args = [
          "-C",
          join(srcRoot, "packages"),
          "--filter",
          packageInfo.packageFilter,
          "run",
          packageInfo.script,
        ];
        commandEnv = { ...deps.env, ...packageInfo.env };
      } else if (starInfo) {
        buildTempDir = await mkdtemp(join(tmpdir(), "cocalc-software-build-"));
        const outputDir = join(buildTempDir, "star-github-release");
        command = starInfo.script;
        args = [outputDir];
        commandEnv = {
          ...deps.env,
          STAR_RELEASE_ID: artifactId,
        };
      } else {
        const rocketInfo = info!;
        buildTempDir = await mkdtemp(join(tmpdir(), "cocalc-software-build-"));
        const outDir = join(buildTempDir, rocketInfo.kind);
        const bundle = join(buildTempDir, rocketInfo.artifactName);
        args = [
          "-C",
          join(srcRoot, "packages"),
          "--filter",
          "@cocalc/rocket",
          "run",
          rocketInfo.script,
          outDir,
          bundle,
        ];
      }
      const code = await deps.runCommand(command, args, {
        stdio: "inherit",
        env: commandEnv,
      });
      if (code !== 0) {
        throw new Error(
          `software build ${component} failed with exit status ${code}`,
        );
      }
      if (packageInfo) {
        sourceFile = packageInfo.artifactPath(srcRoot);
        artifactName = packageInfo.artifactName;
        sourceFiles = packageInfo.artifactFiles?.(srcRoot) ?? [
          { source: sourceFile, name: artifactName },
        ];
      } else if (starInfo) {
        const outputDir = args[0];
        sourceFiles = await listStarReleaseFiles(outputDir);
      } else {
        sourceFile = args.at(-1);
        artifactName = info!.artifactName;
        sourceFiles = [{ source: sourceFile!, name: artifactName }];
      }
      commandText = [command, ...args].join(" ");
    }
  }
  const dir = artifactDir({ localStore, component, artifactId });
  const filesDir = join(dir, "files");
  try {
    if (!sourceFiles?.length) {
      throw new Error(
        `software build ${component} did not resolve an artifact`,
      );
    }
    const artifactFiles: SoftwareArtifactManifest["files"] = [];
    for (const file of sourceFiles) {
      artifactFiles.push(
        await copyArtifactFile({
          source: file.source,
          destinationFilesDir: filesDir,
          name: file.name,
        }),
      );
    }
    const finishedAt = deps.now();
    const manifest: SoftwareArtifactManifest & { local_dir: string } = {
      schema: "cocalc-software-artifact-v1",
      component,
      artifact_id: artifactId,
      tag,
      tag_generated: tagGenerated,
      created_at: createdAt.toISOString(),
      source: {
        repo_root: repoRoot,
        src_root: srcRoot,
        branch: git.branch,
        git_commit: git.commit,
        git_short: git.short,
        git_dirty: git.dirty,
        git_status_porcelain: git.status_porcelain,
      },
      build: {
        host: hostname(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        command: commandText,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      },
      files: artifactFiles,
      local_dir: dir,
    };
    await writeLocalManifest({ localStore, manifest });
    return manifest;
  } finally {
    if (buildTempDir && !opts.keepBuildDir) {
      await rm(buildTempDir, { recursive: true, force: true });
    }
  }
}

function buildSummary(
  manifest: SoftwareArtifactManifest & { local_dir: string },
) {
  const totalSizeBytes = artifactFileTotalSize(manifest.files);
  return {
    component: manifest.component,
    tag: manifest.tag,
    tag_source: manifest.tag_generated ? "generated" : "explicit",
    artifact_id: manifest.artifact_id,
    duration: formatDurationMs(manifest.build.duration_ms),
    git: `${manifest.source.git_short} ${
      manifest.source.git_dirty ? "dirty" : "clean"
    }`,
    local: manifest.local_dir,
    size: `${humanSize(totalSizeBytes)} (${totalSizeBytes} bytes)`,
    files: manifest.files
      .map(
        (file) =>
          `${file.name} ${humanSize(file.size_bytes)} (${file.size_bytes} bytes) sha256:${file.sha256}`,
      )
      .join("\n"),
  };
}

function artifactFileTotalSize(files: Array<{ size_bytes: number }>): number {
  return files.reduce((total, file) => total + file.size_bytes, 0);
}

function artifactSizeSummary(files: Array<{ size_bytes: number }>): {
  size: string;
  size_bytes: number;
} {
  const sizeBytes = artifactFileTotalSize(files);
  return {
    size: humanSize(sizeBytes),
    size_bytes: sizeBytes,
  };
}

async function resolveLocalManifestBySelector({
  localStore,
  component,
  selector,
}: {
  localStore: string;
  component: SoftwareBuildComponent;
  selector: string;
}) {
  const manifests = await listLocalManifests({ localStore, component });
  const matches = findLocalManifestMatches({ manifests, selector });
  if (matches.length === 0) {
    throw new Error(
      `local software artifact not found for ${component}: ${selector}`,
    );
  }
  return matches[0];
}

function findLocalManifestMatches({
  manifests,
  selector,
}: {
  manifests: Awaited<ReturnType<typeof listLocalManifests>>;
  selector: string;
}) {
  if (isSoftwareLatestSelector(selector)) {
    return manifests.slice(0, 1);
  }
  const exactArtifactIdMatches = manifests.filter(
    ({ manifest }) => manifest.artifact_id === selector,
  );
  if (exactArtifactIdMatches.length > 0) {
    return exactArtifactIdMatches;
  }
  return manifests.filter(({ manifest }) => manifest.tag === selector);
}

function softwareR2Client(deps: SoftwareCommandDeps): SoftwareR2Client {
  if (!deps.r2Client) {
    return loadDefaultSoftwareR2Client();
  }
  return typeof deps.r2Client === "function" ? deps.r2Client() : deps.r2Client;
}

function isMissingRemoteConfigError(err: unknown): boolean {
  return `${(err as any)?.message || err}`.includes(
    "Missing R2 software credentials",
  );
}

function mergeListRows({
  localRows,
  remoteRows,
}: {
  localRows: SoftwareListRow[];
  remoteRows: SoftwareListRow[];
}): SoftwareListRow[] {
  const rows = new Map<string, SoftwareListRow>();
  for (const row of localRows) {
    rows.set(row.artifact_id, { ...row });
  }
  for (const row of remoteRows) {
    const existing = rows.get(row.artifact_id);
    if (existing) {
      existing.source =
        existing.source === "local" ? "local+remote" : existing.source;
      existing.remote = row.remote;
      continue;
    }
    rows.set(row.artifact_id, { ...row });
  }
  return [...rows.values()].sort((a, b) => b.created.localeCompare(a.created));
}

async function listRemoteRows({
  component,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  opts: ListOptions;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareListRow[]> {
  try {
    const config = await resolveSoftwareRemoteConfig({
      env: deps.env ?? process.env,
      envFile: opts.envFile,
    });
    const client = softwareR2Client(deps);
    const index = await readRemoteIndex({
      client,
      auth: config.auth,
      component,
    });
    return index.artifacts.map(remoteIndexEntryToListRow);
  } catch (err) {
    if (isMissingRemoteConfigError(err)) {
      return [];
    }
    throw err;
  }
}

function remoteEntryMatchesSelector(
  entry: SoftwareRemoteIndexEntry,
  selector: string,
): boolean {
  return entry.tag === selector || entry.artifact_id === selector;
}

function findRemoteEntryMatches({
  entries,
  selector,
}: {
  entries: SoftwareRemoteIndexEntry[];
  selector: string;
}) {
  if (isSoftwareLatestSelector(selector)) {
    return [...entries]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 1);
  }
  const exactArtifactIdMatches = entries.filter(
    (entry) => entry.artifact_id === selector,
  );
  if (exactArtifactIdMatches.length > 0) {
    return exactArtifactIdMatches;
  }
  return entries
    .filter((entry) => remoteEntryMatchesSelector(entry, selector))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function rocketDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: SoftwareBuildComponent;
      scope: "static" | "hub" | "bay";
      extraArgs?: string[];
      bayService?: string;
      scaffoldOnly?: boolean;
    }
  | undefined {
  if (component === "static") {
    return { artifactComponent: "static", scope: "static" };
  }
  if (component === "hub") {
    return { artifactComponent: "hub", scope: "hub" };
  }
  if (component === "bay") {
    return { artifactComponent: "bay", scope: "bay" };
  }
  if (component === "bay-conat-router") {
    return {
      artifactComponent: "bay",
      scope: "bay",
      extraArgs: ["--bay-service", "conat-router"],
      bayService: "conat-router",
    };
  }
  if (component === "bay-conat-persist") {
    return {
      artifactComponent: "bay",
      scope: "bay",
      extraArgs: ["--bay-service", "conat-persist"],
      bayService: "conat-persist",
    };
  }
  if (component === "bay-frontdoor") {
    return {
      artifactComponent: "bay",
      scope: "bay",
      extraArgs: ["--bay-service", "frontdoor"],
      bayService: "frontdoor",
    };
  }
  if (component === "bay-cloudflared") {
    return {
      artifactComponent: "bay",
      scope: "bay",
      extraArgs: ["--bay-service", "cloudflared"],
      bayService: "cloudflared",
    };
  }
  if (component === "bay-scaffold") {
    return {
      artifactComponent: "bay",
      scope: "bay",
      extraArgs: ["--scaffold-only"],
      scaffoldOnly: true,
    };
  }
  return undefined;
}

function currentCliInvocation(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && script.endsWith(".js")) {
    return { command: process.execPath, args: [script] };
  }
  if (
    script &&
    script !== "software" &&
    script !== "rocket" &&
    (script.includes("/") || existsSync(script))
  ) {
    return { command: script, args: [] };
  }
  return { command: process.execPath, args: [] };
}

function resolveDeploySite({
  profile,
  opts,
  deps,
}: {
  profile: string | undefined;
  opts: DeployOptions;
  deps: SoftwareCommandDeps;
}): {
  profileName: string;
  api?: string;
  remote?: string;
} {
  if (opts.api && opts.remote) {
    return {
      profileName: profile ?? "explicit",
      api: opts.api,
      remote: opts.remote,
    };
  }
  const config = (deps.loadAuthConfig ?? loadDefaultAuthConfig)();
  const profileName = profile ?? config.current_profile ?? "default";
  const authProfile = config.profiles[profileName];
  const api = opts.api ?? authProfile?.api;
  return {
    profileName,
    api,
    remote: opts.remote,
  };
}

type DeployArtifactCandidate =
  | {
      source: "local";
      created: string;
      artifact_id: string;
      tag: string;
      local: Awaited<ReturnType<typeof listLocalManifests>>[number];
    }
  | {
      source: "remote";
      created: string;
      artifact_id: string;
      tag: string;
      remote: SoftwareRemoteIndexEntry;
    };

function newestDeployArtifactCandidate({
  localMatches,
  remoteMatches,
}: {
  localMatches: Awaited<ReturnType<typeof listLocalManifests>>;
  remoteMatches: SoftwareRemoteIndexEntry[];
}): DeployArtifactCandidate | undefined {
  const candidates: DeployArtifactCandidate[] = [
    ...localMatches.map((local) => ({
      source: "local" as const,
      created: local.manifest.created_at,
      artifact_id: local.manifest.artifact_id,
      tag: local.manifest.tag,
      local,
    })),
    ...remoteMatches.map((remote) => ({
      source: "remote" as const,
      created: remote.timestamp,
      artifact_id: remote.artifact_id,
      tag: remote.tag,
      remote,
    })),
  ];
  candidates.sort((a, b) => {
    const byCreated = b.created.localeCompare(a.created);
    if (byCreated !== 0) return byCreated;
    if (a.source !== b.source) return a.source === "local" ? -1 : 1;
    return a.artifact_id.localeCompare(b.artifact_id);
  });
  return candidates[0];
}

function remoteBundleFile(entry: SoftwareRemoteIndexEntry) {
  if (entry.files.length !== 1) {
    throw new Error(
      `software deploy expected exactly one remote file in ${entry.artifact_id}`,
    );
  }
  return entry.files[0];
}

async function resolveDeployArtifact({
  component,
  selector,
  opts,
  deps,
}: {
  component: SoftwareBuildComponent;
  selector: string;
  opts: DeployOptions;
  deps: SoftwareCommandDeps;
}): Promise<{
  tag: string;
  artifact_id: string;
  source: "local+remote" | "local+pushed" | "remote";
  remote_manifest: string;
  files: SoftwareRemoteIndexEntry["files"];
  bundle_url?: string;
  bundle_sha256?: string;
  remote_entry: SoftwareRemoteIndexEntry;
}> {
  const localStore = resolveSoftwareLocalStore({
    option: opts.localStore,
    env: deps.env ?? process.env,
  });
  const localManifests = await listLocalManifests({ localStore, component });
  const config = await resolveSoftwareRemoteConfig({
    env: deps.env ?? process.env,
    envFile: opts.envFile,
  });
  const client = softwareR2Client(deps);
  const remoteIndex = await readRemoteIndex({
    client,
    auth: config.auth,
    component,
  });
  const localMatches = findLocalManifestMatches({
    manifests: localManifests,
    selector,
  });
  const remoteMatches = findRemoteEntryMatches({
    entries: remoteIndex.artifacts,
    selector,
  });
  const candidate = newestDeployArtifactCandidate({
    localMatches,
    remoteMatches,
  });

  if (!candidate) {
    throw new Error(
      `software artifact not found for ${component}: ${selector}`,
    );
  }

  const localMatch =
    candidate.source === "local"
      ? candidate.local
      : localManifests.find(
          ({ manifest }) => manifest.artifact_id === candidate.artifact_id,
        );
  let remoteEntry =
    candidate.source === "remote"
      ? candidate.remote
      : remoteIndex.artifacts.find(
          (entry) => entry.artifact_id === candidate.artifact_id,
        );

  if (localMatch && !remoteEntry) {
    await uploadSoftwareArtifact({
      client,
      config,
      manifest: localMatch.manifest,
      manifestPath: localMatch.path,
      now: deps.now?.() ?? new Date(),
    });
    remoteEntry = manifestRemoteEntry({
      manifest: localMatch.manifest,
      config,
    });
    return {
      tag: localMatch.manifest.tag,
      artifact_id: localMatch.manifest.artifact_id,
      source: "local+pushed",
      remote_manifest: remoteEntry.manifest_url,
      files: remoteEntry.files,
      remote_entry: remoteEntry,
    };
  }

  if (localMatch && remoteEntry) {
    return {
      tag: localMatch.manifest.tag,
      artifact_id: localMatch.manifest.artifact_id,
      source: "local+remote",
      remote_manifest: remoteEntry.manifest_url,
      files: remoteEntry.files,
      remote_entry: remoteEntry,
    };
  }

  if (remoteEntry) {
    return {
      tag: remoteEntry.tag,
      artifact_id: remoteEntry.artifact_id,
      source: "remote",
      remote_manifest: remoteEntry.manifest_url,
      files: remoteEntry.files,
      remote_entry: remoteEntry,
    };
  }

  throw new Error(`software artifact not found for ${component}: ${selector}`);
}

function hostDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: SoftwareBuildComponent;
      upgradeArtifact:
        | "project-host"
        | "container-runtime"
        | "project"
        | "tools";
      managedComponents?: HostManagedSoftwareComponent[];
      publishOnly?: boolean;
      pacedFleetRollout?: boolean;
    }
  | undefined {
  if (component === "project-host") {
    return {
      artifactComponent: component,
      upgradeArtifact: component,
      managedComponents: ["project-host"],
      pacedFleetRollout: true,
    };
  }
  if (component === "container-runtime") {
    return {
      artifactComponent: component,
      upgradeArtifact: component,
      // Container runtime changes have a much larger host-level blast radius
      // than ordinary bundles. Publishing must not mutate fleet desired state.
      publishOnly: true,
    };
  }
  if (component === "project" || component === "tools") {
    return {
      artifactComponent: component,
      upgradeArtifact: component,
    };
  }
  if (component === "host-conat-router") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponents: ["conat-router"],
      pacedFleetRollout: true,
    };
  }
  if (component === "host-conat-persist") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponents: ["conat-persist"],
      pacedFleetRollout: true,
    };
  }
  if (component === "host-acp-worker") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponents: ["acp-worker"],
      pacedFleetRollout: true,
    };
  }
  if (component === "host-runtime-stack") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponents: HOST_RUNTIME_STACK_COMPONENTS,
      pacedFleetRollout: true,
    };
  }
  return undefined;
}

function hostManagedComponentsForDeployComponent(
  component: SoftwareDeployComponent,
): HostManagedSoftwareComponent[] | undefined {
  return hostDeployTargetForComponent(component)?.managedComponents;
}

function hostBootstrapDeployTargetForComponent(
  component: SoftwareDeployComponent,
):
  | {
      artifactComponent: "host-bootstrap";
    }
  | undefined {
  return component === "host-bootstrap"
    ? { artifactComponent: "host-bootstrap" }
    : undefined;
}

function releaseDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: "cli" | "launchpad" | "plus";
    }
  | undefined {
  if (
    component === "cli" ||
    component === "launchpad" ||
    component === "plus"
  ) {
    return { artifactComponent: component };
  }
  return undefined;
}

function releaseProductForArtifactComponent(
  component: "cli" | "launchpad" | "plus",
): "cocalc" | "cocalc-launchpad" | "cocalc-plus" {
  return component === "cli"
    ? "cocalc"
    : component === "launchpad"
      ? "cocalc-launchpad"
      : "cocalc-plus";
}

function releaseChannelEnvForArtifactComponent(
  component: "cli" | "launchpad" | "plus",
): "COCALC_CLI_CHANNEL" | "COCALC_LAUNCHPAD_CHANNEL" | "COCALC_PLUS_CHANNEL" {
  return component === "cli"
    ? "COCALC_CLI_CHANNEL"
    : component === "launchpad"
      ? "COCALC_LAUNCHPAD_CHANNEL"
      : "COCALC_PLUS_CHANNEL";
}

function releaseInstallInfo({
  component,
  channel,
  publicBaseUrl,
}: {
  component: "cli" | "launchpad" | "plus";
  channel: string;
  publicBaseUrl: string;
}): {
  install_url: string;
  install_channel_env: string;
  install_command: string;
  windows_install_url?: string;
  windows_install_command?: string;
  available_channels: string[];
} {
  const product = releaseProductForArtifactComponent(component);
  const envName = releaseChannelEnvForArtifactComponent(component);
  const installUrl = `${publicBaseUrl}/software/${product}/install.sh`;
  const windowsInstallUrl = `${publicBaseUrl}/software/${product}/install.ps1`;
  return {
    install_url: installUrl,
    install_channel_env: `${envName}=${channel}`,
    install_command: `curl -fsSL ${installUrl} | ${envName}=${channel} bash`,
    ...(component === "cli"
      ? {
          windows_install_url: windowsInstallUrl,
          windows_install_command: `$env:COCALC_CLI_CHANNEL='${channel}'; irm ${windowsInstallUrl} | iex`,
        }
      : {}),
    available_channels: ["dev", "candidate", "stable"],
  };
}

function starDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: "star";
    }
  | undefined {
  return component === "star" ? { artifactComponent: "star" } : undefined;
}

function starGithubRepo(deps: SoftwareCommandDeps): string {
  return (
    `${deps.env?.COCALC_STAR_GITHUB_REPO ?? process.env.COCALC_STAR_GITHUB_REPO ?? ""}`.trim() ||
    "sagemathinc/cocalc-ai"
  );
}

function starChannelTag({
  channel,
  deps,
}: {
  channel: string;
  deps: SoftwareCommandDeps;
}): string {
  return (
    `${deps.env?.COCALC_STAR_CHANNEL_TAG ?? process.env.COCALC_STAR_CHANNEL_TAG ?? ""}`.trim() ||
    `cocalc-star-${channel}`
  );
}

function starInstallInfo({
  repo,
  channelTag,
}: {
  repo: string;
  channelTag: string;
}): {
  github_repo: string;
  channel_tag: string;
  install_url: string;
  install_command: string;
  lima_install_url: string;
  lima_install_command: string;
  available_channels: string[];
} {
  const baseUrl = `https://github.com/${repo}/releases/download/${channelTag}`;
  const installUrl = `${baseUrl}/install-cocalc-star.sh`;
  const limaInstallUrl = `${baseUrl}/install-cocalc-star-local-lima.sh`;
  return {
    github_repo: repo,
    channel_tag: channelTag,
    install_url: installUrl,
    install_command: `curl -fsSL ${installUrl} | bash`,
    lima_install_url: limaInstallUrl,
    lima_install_command: `curl -fsSL ${limaInstallUrl} | bash`,
    available_channels: ["dev", "candidate", "stable"],
  };
}

function deploymentId({
  startedAt,
  artifactId,
}: {
  startedAt: Date;
  artifactId: string;
}): string {
  return `${compactTimestamp(startedAt)}-${artifactId}`;
}

function deploymentRecordBase({
  component,
  artifactComponent,
  profileOrChannel,
  startedAt,
  artifact,
  target,
  kind,
  details,
}: {
  component: SoftwareDeployComponent;
  artifactComponent: SoftwareBuildComponent;
  profileOrChannel: string;
  startedAt: Date;
  artifact: Awaited<ReturnType<typeof resolveDeployArtifact>>;
  target: ReturnType<typeof resolveDeploySite>;
  kind: SoftwareDeploymentRecord["target"]["kind"];
  details?: Record<string, unknown>;
}): SoftwareDeploymentRecord {
  const git = artifact.remote_entry.git;
  return {
    schema: "cocalc-software-deployment-v1",
    deployment_id: deploymentId({
      startedAt,
      artifactId: artifact.artifact_id,
    }),
    component,
    artifact_component: artifactComponent,
    profile_or_channel: profileOrChannel,
    started_at: startedAt.toISOString(),
    updated_at: startedAt.toISOString(),
    artifact_id: artifact.artifact_id,
    tag: artifact.tag,
    git,
    // Deployment records are published through the public software bucket.
    // Never put operator identity, local hostnames, or SSH targets in them.
    deployed_by: {},
    target: {
      kind,
      ...(kind === "release-channel"
        ? { channel: profileOrChannel }
        : { profile: profileOrChannel }),
      api: target.api,
    },
    status: "started",
    details,
  };
}

async function writeDeploymentRecordBestEffort({
  client,
  config,
  record,
  deps,
}: {
  client: SoftwareR2Client;
  config: Awaited<ReturnType<typeof resolveSoftwareRemoteConfig>>;
  record: SoftwareDeploymentRecord;
  deps: SoftwareCommandDeps;
}): Promise<void> {
  await writeDeploymentRecord({
    client,
    config,
    record,
    now: deps.now?.() ?? new Date(),
  });
}

async function runWithDeploymentHistory({
  record,
  client,
  config,
  deps,
  run,
}: {
  record: SoftwareDeploymentRecord;
  client: SoftwareR2Client;
  config: Awaited<ReturnType<typeof resolveSoftwareRemoteConfig>>;
  deps: SoftwareCommandDeps;
  run: () => Promise<void>;
}): Promise<SoftwareDeploymentRecord> {
  await writeDeploymentRecordBestEffort({ client, config, record, deps });
  try {
    await run();
  } catch (err) {
    const finishedAt = deps.now?.() ?? new Date();
    const failed: SoftwareDeploymentRecord = {
      ...record,
      updated_at: finishedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status: "failed",
      duration_ms: Math.max(
        0,
        finishedAt.getTime() - new Date(record.started_at).getTime(),
      ),
      error: err instanceof Error ? err.message : `${err}`,
    };
    try {
      await writeDeploymentRecordBestEffort({
        client,
        config,
        record: failed,
        deps,
      });
    } catch (historyErr) {
      process.stderr.write(
        `WARNING: failed to seal software deployment failure history: ${
          historyErr instanceof Error ? historyErr.message : historyErr
        }\n`,
      );
    }
    throw err;
  }
  const finishedAt = deps.now?.() ?? new Date();
  const succeeded: SoftwareDeploymentRecord = {
    ...record,
    updated_at: finishedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: "succeeded",
    duration_ms: Math.max(
      0,
      finishedAt.getTime() - new Date(record.started_at).getTime(),
    ),
  };
  await writeDeploymentRecordBestEffort({
    client,
    config,
    record: succeeded,
    deps,
  });
  return succeeded;
}

export function registerSoftwareCommand(
  program: Command,
  deps: SoftwareCommandDeps = {},
): Command {
  const software = program
    .command("software")
    .description("high-level CoCalc software artifact lifecycle")
    .addHelpText(
      "after",
      `

Supported build/list/push components:
  ${BUILD_COMPONENTS_HELP}

Supported deploy/smoke components:
  ${DEPLOY_COMPONENTS_HELP}`,
    );

  software
    .command("info")
    .description("describe software components for humans or agents")
    .argument("[component]", INFO_COMPONENT_ARGUMENT)
    .action(function (this: Command, componentArg: string | undefined) {
      const globals = this.optsWithGlobals() as any;
      const payload = softwareInfoPayload(componentArg);
      if (globals.json || globals.output === "json") {
        emitSuccess({ globals }, "software info", payload);
        return;
      }
      console.log(formatSoftwareInfoPayload(payload));
    });

  software
    .command("build")
    .description("build or record a local immutable software artifact")
    .argument(
      "<component[:tag]>",
      `${BUILD_COMPONENT_ARGUMENT}; tag is generated if omitted`,
    )
    .allowExcessArguments(true)
    .option("--local-store <path>", "local artifact store")
    .option(
      "--from-file <path>",
      "record an existing artifact file in the local software store",
    )
    .option(
      "--from-directory <path>",
      "record a complete multi-platform CLI release directory",
    )
    .option("--artifact-name <name>", "override stored artifact file name")
    .option(
      "--artifact-id <id>",
      "use a precomputed immutable artifact id (CI release assembly)",
    )
    .option("--keep-build-dir", "keep temporary component build directory")
    .action(
      async (
        componentSelectorArg: string,
        opts: BuildOptions,
        command: Command,
      ) => {
        if (command.args.length > 2) {
          throw new Error("software build accepts <component[:tag]>");
        }
        const { component, tagArg } = parseBuildComponentSelector({
          componentSelectorArg,
          legacyTagArg: command.args[1],
        });
        const manifest = await buildFromFile({
          component,
          tagArg,
          opts,
          deps: {
            cwd: deps.cwd,
            env: deps.env ?? process.env,
            now: deps.now ?? (() => new Date()),
            gitMetadata: deps.gitMetadata,
            repoRoot: deps.repoRoot,
            runCommand: deps.runCommand,
          },
        });
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software build",
          buildSummary(manifest),
        );
      },
    );

  software
    .command("list")
    .alias("ls")
    .description("list local software artifacts")
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .option("--local-store <path>", "local artifact store")
    .option("--no-remote", "only show local artifacts")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option("--limit <n>", "maximum rows to show", "10")
    .action(
      async (componentArg: string, opts: ListOptions, command: Command) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
        const limit = parseLimit(opts.limit);
        const localRows = (
          await listLocalManifests({ localStore, component })
        ).map(manifestToListRow);
        const remoteRows =
          opts.remote === false
            ? []
            : await listRemoteRows({ component, opts, deps });
        const rows = mergeListRows({ localRows, remoteRows }).slice(0, limit);
        const globals = command.optsWithGlobals() as any;
        if (globals.json || globals.output === "json") {
          emitSuccess({ globals }, "software list", {
            component,
            local_store: localStore,
            artifacts: rows,
          });
          return;
        }
        printArrayTable(rows);
      },
    );

  software
    .command("push")
    .description("push a local software artifact to the remote software store")
    .argument(
      "<component:tag-or-id>",
      `${BUILD_COMPONENT_ARGUMENT}; artifact tag or id`,
    )
    .allowExcessArguments(true)
    .option(
      "--build",
      "build the component tag before pushing; tag is generated if omitted",
    )
    .option("--local-store <path>", "local artifact store")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .action(
      async (
        componentSelectorArg: string,
        opts: PushOptions,
        command: Command,
      ) => {
        if (command.args.length > 2) {
          throw new Error("software push accepts <component:tag-or-id>");
        }
        let { component, selector } = parsePushComponentSelector({
          componentSelectorArg,
          legacySelectorArg: command.args[1],
          allowMissingSelector: opts.build,
        });
        const startedAt = deps.now?.() ?? new Date();
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
        let builtArtifact:
          | (SoftwareArtifactManifest & { local_dir: string })
          | undefined;
        if (opts.build) {
          builtArtifact = await buildFromFile({
            component,
            tagArg: selector,
            opts: {
              localStore: opts.localStore,
            },
            deps: {
              cwd: deps.cwd,
              env: deps.env ?? process.env,
              now: deps.now ?? (() => new Date()),
              gitMetadata: deps.gitMetadata,
              repoRoot: deps.repoRoot,
              runCommand: deps.runCommand,
            },
          });
          selector = builtArtifact.artifact_id;
        }
        if (!selector) {
          throw new Error("software push requires <component:tag-or-id>");
        }
        const { manifest, path } = await resolveLocalManifestBySelector({
          localStore,
          component,
          selector,
        });
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        await uploadSoftwareArtifact({
          client,
          config,
          manifest,
          manifestPath: path,
          now: deps.now?.() ?? new Date(),
          allowExisting: true,
        });
        const entry = manifestRemoteEntry({ manifest, config });
        const hostCompat = isHostCompatibilityComponent(component)
          ? await publishHostCompatibilityArtifact({
              client,
              config,
              entry,
            })
          : undefined;
        const hostBootstrap =
          component === "host-bootstrap"
            ? await publishHostBootstrapArtifact({
                client,
                config,
                entry,
                selector: manifest.artifact_id,
              })
            : undefined;
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software push",
          {
            component,
            tag: manifest.tag,
            artifact_id: manifest.artifact_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            ...(builtArtifact
              ? {
                  built: true,
                  built_component: builtArtifact.component,
                  built_artifact_id: builtArtifact.artifact_id,
                }
              : {}),
            remote_manifest: entry.manifest_url,
            index: `${config.publicBaseUrl}/${indexKey(component)}`,
            files: entry.files.map((file) => file.url),
            ...(hostCompat
              ? {
                  host_base_url: hostCompat.base_url,
                  host_files: hostCompat.urls,
                  host_catalogs: hostCompat.catalog_urls,
                }
              : {}),
            ...(hostBootstrap
              ? {
                  host_bootstrap_selector: hostBootstrap.selector,
                  host_bootstrap_url: hostBootstrap.url,
                  host_bootstrap_sha256_url: hostBootstrap.sha256_url,
                }
              : {}),
          },
        );
      },
    );

  software
    .command("deploy")
    .description("deploy or promote a software artifact")
    .argument(
      "<component[,component...][:tag]>",
      `${DEPLOY_COMPONENT_ARGUMENT}; components may be comma-separated; tag defaults to latest`,
    )
    .argument("[profile-or-channel]", PROFILE_OR_CHANNEL_ARGUMENT)
    .allowExcessArguments(true)
    .option(
      "--build",
      "build the component tag before deploying; deploy-only service components build their underlying artifact component",
    )
    .option(
      "--rollout",
      "for host runtime components, install on online hosts; managed components use a durable canary-first rollout",
    )
    .option("--rollout-canary <host>", "project-host rollout canary")
    .option(
      "--rollout-max-concurrent <count>",
      "maximum project hosts in each post-canary wave",
      "2",
    )
    .option(
      "--rollout-canary-stabilize-seconds <seconds>",
      "healthy time required after the project-host canary",
      "180",
    )
    .option(
      "--rollout-stabilize-seconds <seconds>",
      "healthy time required after later project-host waves",
      "60",
    )
    .option(
      "--bootstrap-scope <scope>",
      "with host-bootstrap --rollout: full restarts project-host; helpers updates privileged helpers without daemon restarts",
    )
    .option(
      "--bootstrap-publish-channel <channel>",
      "with host-bootstrap: explicitly update the mutable latest or staging bootstrap channel",
    )
    .option("--local-store <path>", "local artifact store")
    .option("--config <path>", "rocket config path")
    .option("--remote <ssh-target>", "bay SSH target")
    .option("--api <url>", "site API URL")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option(
      "--tools-minimal <tag-or-id>",
      "tools-minimal artifact selector to promote with plus; defaults to the plus selector",
    )
    .action(
      async (
        componentSelectorArg: string,
        targetArg: string | undefined,
        opts: DeployOptions,
        command: Command,
      ) => {
        if (command.args.length > 3) {
          throw new Error(
            "software deploy accepts <component[,component...][:tag]> <profile-or-channel>",
          );
        }
        const {
          components,
          selector: requestedSelector,
          profileOrChannel: deployTarget,
          selectorExplicit,
        } = parseDeployComponentSelector({
          componentSelectorArg,
          targetArg,
          legacyTargetArg: command.args[2],
        });
        const deployTargets = splitDeployTargets(deployTarget);
        const deployTargetKinds = new Set(
          components.map((component) =>
            deployTargetKindForComponent(component),
          ),
        );
        if (deployTargetKinds.size > 1) {
          throw new Error(
            "software deploy cannot mix site-profile components and release-channel components in one command",
          );
        }
        const bootstrapScope = parseHostBootstrapScope(opts.bootstrapScope);
        const bootstrapPublishChannel = parseHostBootstrapPublishChannel(
          opts.bootstrapPublishChannel,
        );
        const deploysHostBootstrap = components.includes("host-bootstrap");
        if (deploysHostBootstrap && opts.rollout && !bootstrapScope) {
          throw new Error(
            "software deploy host-bootstrap --rollout requires --bootstrap-scope full, helpers, or environment",
          );
        }
        if (deploysHostBootstrap && !opts.rollout && bootstrapScope) {
          throw new Error(
            "software deploy host-bootstrap --bootstrap-scope requires --rollout",
          );
        }
        if (!deploysHostBootstrap && bootstrapScope) {
          throw new Error(
            "--bootstrap-scope is only valid when deploying host-bootstrap",
          );
        }
        if (!deploysHostBootstrap && bootstrapPublishChannel) {
          throw new Error(
            "--bootstrap-publish-channel is only valid when deploying host-bootstrap",
          );
        }
        await runDeployTypecheck(deps);
        const startedAt = deps.now?.() ?? new Date();
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const cli = currentCliInvocation();
        const globals = command.optsWithGlobals() as any;
        const deploymentSummaries: Array<Record<string, unknown>> = [];
        const deployUnitCount = components.length * deployTargets.length;
        for (const component of components) {
          let selector = requestedSelector;
          const rocketTarget = rocketDeployTargetForComponent(component);
          const hostTarget = hostDeployTargetForComponent(component);
          const hostBootstrapTarget =
            hostBootstrapDeployTargetForComponent(component);
          const releaseTarget = releaseDeployTargetForComponent(component);
          const starTarget = starDeployTargetForComponent(component);
          assertSingleReleaseDeployTarget({
            component,
            targets: deployTargets,
          });
          const firstDeployTarget = deployTargets[0];
          const releaseChannel =
            releaseTarget || starTarget
              ? validateSoftwareReleaseChannel(firstDeployTarget)
              : undefined;
          const artifactComponent =
            rocketTarget?.artifactComponent ??
            hostTarget?.artifactComponent ??
            hostBootstrapTarget?.artifactComponent ??
            releaseTarget?.artifactComponent ??
            starTarget?.artifactComponent;
          if (!artifactComponent) {
            throw new Error(
              `software deploy ${component} is not wired yet; currently supported: ${DEPLOY_COMPONENTS_HELP}`,
            );
          }
          if (!releaseTarget && !deps.runCommand) {
            throw new Error("software deploy requires runCommand dependency");
          }
          let builtArtifact:
            | (SoftwareArtifactManifest & { local_dir: string })
            | undefined;
          if (opts.build) {
            builtArtifact = await buildFromFile({
              component: artifactComponent,
              tagArg: selectorExplicit ? selector : undefined,
              opts: {
                localStore: opts.localStore,
              },
              deps: {
                cwd: deps.cwd,
                env: deps.env ?? process.env,
                now: deps.now ?? (() => new Date()),
                gitMetadata: deps.gitMetadata,
                repoRoot: deps.repoRoot,
                runCommand: deps.runCommand,
              },
            });
            selector = builtArtifact.artifact_id;
          }
          const artifact = await resolveDeployArtifact({
            component: artifactComponent,
            selector,
            opts,
            deps,
          });
          for (const deployTarget of deployTargets) {
            const targetStartedAt = deps.now?.() ?? new Date();
            const target =
              releaseTarget || starTarget
                ? {
                    profileName: releaseChannel!,
                    api: undefined,
                    remote: undefined,
                    account_id: undefined,
                    email_address: undefined,
                  }
                : resolveDeploySite({
                    profile: deployTarget,
                    opts,
                    deps,
                  });
            let commandArgsList: string[][] = [];
            let rocketScope: string | undefined;
            let hostBaseUrl: string | undefined;
            let hostCompatUrl: string | undefined;
            let hostCatalogUrls: string[] | undefined;
            let hostManagedComponents:
              | HostManagedSoftwareComponent[]
              | undefined;
            let hostBootstrapUrl: string | undefined;
            let hostBootstrapSha256Url: string | undefined;
            let releaseProduct: string | undefined;
            let releaseInstall:
              | ReturnType<typeof releaseInstallInfo>
              | undefined;
            let releaseChannelManifestUrls: string[] | undefined;
            let releaseInstallerPublication:
              | Awaited<ReturnType<typeof publishReleaseInstaller>>
              | undefined;
            let releasePowerShellInstallerPublication:
              | Awaited<ReturnType<typeof publishReleasePowerShellInstaller>>
              | undefined;
            let toolsMinimalArtifact:
              | Awaited<ReturnType<typeof resolveDeployArtifact>>
              | undefined;
            let toolsMinimalSelector: string | undefined;
            let toolsMinimalChannelManifestUrls: string[] | undefined;
            let starInstall: ReturnType<typeof starInstallInfo> | undefined;
            let starPromoteScript: string | undefined;
            let targetKind: SoftwareDeploymentRecord["target"]["kind"];
            if (rocketTarget) {
              const remoteFile = remoteBundleFile(artifact.remote_entry);
              artifact.bundle_url = remoteFile.url;
              artifact.bundle_sha256 = remoteFile.sha256;
              rocketScope = rocketTarget.scope;
              targetKind = "rocket-bay";
              commandArgsList = [
                [
                  ...cli.args,
                  "rocket",
                  "deploy",
                  deployTarget,
                  "--scope",
                  rocketScope,
                  "--bundle-url",
                  artifact.bundle_url,
                  "--bundle-sha256",
                  artifact.bundle_sha256,
                  ...(opts.config ? ["--config", opts.config] : []),
                  ...(target.remote ? ["--remote", target.remote] : []),
                  ...(target.api ? ["--api", target.api] : []),
                  ...(rocketTarget.extraArgs ?? []),
                  "--yes",
                ],
              ];
            } else if (hostTarget) {
              if (hostTarget.publishOnly && opts.rollout) {
                throw new Error(
                  `software deploy ${component} does not support --rollout; publish it first, then explicitly upgrade selected canary hosts`,
                );
              }
              const compat = await publishHostCompatibilityArtifact({
                client,
                config,
                entry: artifact.remote_entry,
              });
              hostBaseUrl = compat.base_url;
              hostCompatUrl = compat.urls.join("\n");
              hostCatalogUrls = compat.catalog_urls;
              hostManagedComponents = hostTarget.managedComponents;
              targetKind = "project-host-fleet";
              const reason = `software-deploy-${component}`;
              if (hostTarget.pacedFleetRollout) {
                commandArgsList = [
                  [
                    ...cli.args,
                    "--profile",
                    deployTarget,
                    "host",
                    "deploy",
                    "rollout-fleet",
                    "--all-online",
                    "--desired-version",
                    artifact.artifact_id,
                    ...(hostManagedComponents ?? []).flatMap((component) => [
                      "--component",
                      component,
                    ]),
                    "--base-url",
                    hostBaseUrl,
                    "--max-concurrent",
                    `${opts.rolloutMaxConcurrent ?? "2"}`,
                    "--canary-stabilize-seconds",
                    `${opts.rolloutCanaryStabilizeSeconds ?? "180"}`,
                    "--stabilize-seconds",
                    `${opts.rolloutStabilizeSeconds ?? "60"}`,
                    "--reason",
                    reason,
                    ...(opts.rolloutCanary
                      ? ["--canary", opts.rolloutCanary]
                      : []),
                    "--wait",
                  ],
                ];
              } else {
                commandArgsList = hostTarget.publishOnly
                  ? []
                  : [
                      [
                        ...cli.args,
                        "--profile",
                        deployTarget,
                        "host",
                        "deploy",
                        "set",
                        "--global",
                        "--artifact",
                        runtimeArtifactForHostUpgradeArtifact(
                          hostTarget.upgradeArtifact,
                        ),
                        "--desired-version",
                        artifact.artifact_id,
                        "--reason",
                        reason,
                      ],
                    ];
                const upgradeOnlineHosts =
                  opts.rollout === true || component === "tools";
                if (upgradeOnlineHosts) {
                  commandArgsList.push([
                    ...cli.args,
                    "--profile",
                    deployTarget,
                    "host",
                    "upgrade",
                    "--all-online",
                    "--artifact",
                    hostTarget.upgradeArtifact,
                    "--artifact-version",
                    artifact.artifact_id,
                    "--base-url",
                    hostBaseUrl,
                    "--preserve-desired-state",
                    "--wait",
                  ]);
                }
              }
            } else if (hostBootstrapTarget) {
              const bootstrapSha256 = remoteBundleFile(
                artifact.remote_entry,
              ).sha256;
              targetKind = "project-host-fleet";
              commandArgsList = [
                [
                  ...cli.args,
                  "--profile",
                  deployTarget,
                  "host",
                  "deploy",
                  "set",
                  "--global",
                  "--artifact",
                  "bootstrap-environment",
                  "--desired-version",
                  bootstrapSha256,
                  "--reason",
                  "software-deploy-host-bootstrap",
                ],
                [
                  ...cli.args,
                  "--profile",
                  deployTarget,
                  "host",
                  "deploy",
                  "resume-default",
                  "--all-hosts",
                  "--artifact",
                  "bootstrap-environment",
                ],
              ];
              if (opts.rollout) {
                commandArgsList.push([
                  ...cli.args,
                  "--profile",
                  deployTarget,
                  "host",
                  "reconcile",
                  "--all-online",
                  "--force-bootstrap",
                  "--bootstrap-scope",
                  bootstrapScope!,
                  "--wait",
                ]);
              }
            } else if (releaseTarget) {
              releaseProduct = releaseProductForArtifactComponent(
                releaseTarget.artifactComponent,
              );
              releaseInstall = releaseInstallInfo({
                component: releaseTarget.artifactComponent,
                channel: releaseChannel!,
                publicBaseUrl: config.publicBaseUrl,
              });
              if (releaseTarget.artifactComponent === "plus") {
                toolsMinimalSelector =
                  `${opts.toolsMinimal ?? selector}`.trim();
                try {
                  toolsMinimalArtifact = await resolveDeployArtifact({
                    component: "tools-minimal",
                    selector: toolsMinimalSelector,
                    opts,
                    deps,
                  });
                } catch (err) {
                  if (opts.toolsMinimal) {
                    throw err;
                  }
                  throw new Error(
                    `software deploy plus requires a matching tools-minimal artifact; build/push tools-minimal with tag '${selector}' or pass --tools-minimal <tag-or-id>`,
                  );
                }
              }
              targetKind = "release-channel";
            } else if (starTarget) {
              const cwd = resolve(deps.cwd ?? process.cwd());
              const { srcRoot } = resolveRepoLayout({ cwd, deps });
              const repo = starGithubRepo(deps);
              const channelTag = starChannelTag({
                channel: releaseChannel!,
                deps,
              });
              releaseProduct = "cocalc-star";
              starPromoteScript = join(
                srcRoot,
                "scripts",
                "star",
                "promote-github-release-channel.sh",
              );
              starInstall = starInstallInfo({ repo, channelTag });
              targetKind = "release-channel";
            } else {
              throw new Error(`software deploy ${component} is not wired yet`);
            }
            const record = deploymentRecordBase({
              component,
              artifactComponent,
              profileOrChannel: deployTarget,
              startedAt: targetStartedAt,
              artifact,
              target,
              kind: targetKind,
              details: {
                source: artifact.source,
                remote_manifest: artifact.remote_manifest,
                files: artifact.files.map((file) => ({
                  name: file.name,
                  url: file.url,
                  sha256: file.sha256,
                  size_bytes: file.size_bytes,
                })),
                ...(artifact.bundle_url
                  ? { bundle_url: artifact.bundle_url }
                  : {}),
                ...(artifact.bundle_sha256
                  ? { bundle_sha256: artifact.bundle_sha256 }
                  : {}),
                ...(rocketScope ? { rocket_scope: rocketScope } : {}),
                ...(rocketTarget?.bayService
                  ? { bay_service: rocketTarget.bayService }
                  : {}),
                ...(rocketTarget?.scaffoldOnly ? { scaffold_only: true } : {}),
                ...(hostBaseUrl ? { host_software_base_url: hostBaseUrl } : {}),
                ...(hostCompatUrl ? { host_compat_url: hostCompatUrl } : {}),
                ...(hostCatalogUrls?.length
                  ? { host_catalog_urls: hostCatalogUrls }
                  : {}),
                ...(hostManagedComponents?.length === 1
                  ? { host_managed_component: hostManagedComponents[0] }
                  : {}),
                ...(hostManagedComponents?.length
                  ? { host_managed_components: hostManagedComponents }
                  : {}),
                ...(hostTarget
                  ? {
                      host_rollout:
                        hostTarget.pacedFleetRollout === true ||
                        opts.rollout === true ||
                        component === "tools",
                    }
                  : {}),
                ...(hostBootstrapTarget
                  ? {
                      host_bootstrap_reconcile: opts.rollout === true,
                      ...(bootstrapScope
                        ? { host_bootstrap_scope: bootstrapScope }
                        : {}),
                    }
                  : {}),
                ...(hostBootstrapUrl
                  ? { host_bootstrap_url: hostBootstrapUrl }
                  : {}),
                ...(hostBootstrapSha256Url
                  ? { host_bootstrap_sha256_url: hostBootstrapSha256Url }
                  : {}),
                ...(bootstrapPublishChannel
                  ? {
                      host_bootstrap_publish_channel: bootstrapPublishChannel,
                    }
                  : {}),
                ...(releaseProduct ? { release_product: releaseProduct } : {}),
                ...(releaseChannel ? { release_channel: releaseChannel } : {}),
                ...(releaseInstall ?? {}),
                ...(toolsMinimalArtifact
                  ? {
                      tools_minimal: {
                        selector: toolsMinimalSelector,
                        artifact_id: toolsMinimalArtifact.artifact_id,
                        tag: toolsMinimalArtifact.tag,
                        source: toolsMinimalArtifact.source,
                        remote_manifest: toolsMinimalArtifact.remote_manifest,
                        files: toolsMinimalArtifact.files.map((file) => ({
                          name: file.name,
                          url: file.url,
                          sha256: file.sha256,
                          size_bytes: file.size_bytes,
                        })),
                      },
                    }
                  : {}),
                ...(starInstall ?? {}),
              },
            });
            const finalRecord = await runWithDeploymentHistory({
              record,
              client,
              config,
              deps,
              run: async () => {
                if (releaseTarget) {
                  if (releaseTarget.artifactComponent === "cli") {
                    const cwd = resolve(deps.cwd ?? process.cwd());
                    const { srcRoot } = resolveRepoLayout({ cwd, deps });
                    releaseInstallerPublication = await publishReleaseInstaller(
                      {
                        client,
                        config,
                        product: "cocalc",
                        body: await readFile(
                          join(srcRoot, "packages", "cli", "install.sh"),
                        ),
                      },
                    );
                    releasePowerShellInstallerPublication =
                      await publishReleasePowerShellInstaller({
                        client,
                        config,
                        product: "cocalc",
                        body: await readFile(
                          join(srcRoot, "packages", "cli", "install.ps1"),
                        ),
                      });
                  }
                  if (toolsMinimalArtifact) {
                    const publishedToolsMinimal =
                      await publishReleaseChannelArtifact({
                        client,
                        config,
                        entry: toolsMinimalArtifact.remote_entry,
                        channel: releaseChannel!,
                        now: deps.now?.() ?? new Date(),
                      });
                    toolsMinimalChannelManifestUrls =
                      publishedToolsMinimal.manifests.map(
                        (manifest) => manifest.url,
                      );
                  }
                  const published = await publishReleaseChannelArtifact({
                    client,
                    config,
                    entry: artifact.remote_entry,
                    channel: releaseChannel!,
                    now: deps.now?.() ?? new Date(),
                  });
                  releaseProduct = published.product;
                  releaseChannelManifestUrls = published.manifests.map(
                    (manifest) => manifest.url,
                  );
                  record.details = {
                    ...(record.details ?? {}),
                    release_product: published.product,
                    release_channel: published.channel,
                    channel_manifests: releaseChannelManifestUrls,
                    ...(releaseInstallerPublication
                      ? {
                          installer: releaseInstallerPublication,
                        }
                      : {}),
                    ...(releasePowerShellInstallerPublication
                      ? {
                          powershell_installer:
                            releasePowerShellInstallerPublication,
                        }
                      : {}),
                    ...(toolsMinimalChannelManifestUrls
                      ? {
                          tools_minimal_channel_manifests:
                            toolsMinimalChannelManifestUrls,
                        }
                      : {}),
                    ...(published.channel === "stable"
                      ? { latest_alias: "updated" }
                      : {}),
                    ...(releaseInstall ?? {}),
                  };
                  return;
                }
                if (starTarget) {
                  const repo = starInstall!.github_repo;
                  const viewCode = await deps.runCommand!(
                    "gh",
                    ["release", "view", artifact.artifact_id, "--repo", repo],
                    {
                      stdio: "inherit",
                      env: deps.env ?? process.env,
                    },
                  );
                  if (viewCode !== 0) {
                    throw new Error(
                      `immutable Star GitHub release ${artifact.artifact_id} was not found in ${repo}; upload the release assets before promoting ${releaseChannel}`,
                    );
                  }
                  const promoteCode = await deps.runCommand!(
                    starPromoteScript!,
                    ["--upload", artifact.artifact_id, releaseChannel!],
                    {
                      stdio: "inherit",
                      env: {
                        ...(deps.env ?? process.env),
                        COCALC_STAR_GITHUB_REPO: repo,
                        COCALC_STAR_GIT_REVISION:
                          artifact.remote_entry.git.commit,
                      },
                    },
                  );
                  if (promoteCode !== 0) {
                    throw new Error(
                      `software deploy star failed with exit status ${promoteCode}`,
                    );
                  }
                  record.details = {
                    ...(record.details ?? {}),
                    release_product: releaseProduct,
                    release_channel: releaseChannel,
                    github_release: artifact.artifact_id,
                    ...(starInstall ?? {}),
                  };
                  return;
                }
                if (hostBootstrapTarget) {
                  const published = await publishHostBootstrapArtifact({
                    client,
                    config,
                    entry: artifact.remote_entry,
                    selector: artifact.artifact_id,
                  });
                  if (bootstrapPublishChannel) {
                    await publishHostBootstrapArtifact({
                      client,
                      config,
                      entry: artifact.remote_entry,
                      selector: bootstrapPublishChannel,
                    });
                  }
                  hostBootstrapUrl = published.url;
                  hostBootstrapSha256Url = published.sha256_url;
                  record.details = {
                    ...(record.details ?? {}),
                    host_bootstrap_selector: published.selector,
                    host_bootstrap_url: hostBootstrapUrl,
                    host_bootstrap_sha256_url: hostBootstrapSha256Url,
                    ...(bootstrapPublishChannel
                      ? {
                          host_bootstrap_publish_channel:
                            bootstrapPublishChannel,
                        }
                      : {}),
                    host_bootstrap_reconcile: opts.rollout === true,
                    ...(bootstrapScope
                      ? { host_bootstrap_scope: bootstrapScope }
                      : {}),
                  };
                }
                for (const args of commandArgsList) {
                  const code = await deps.runCommand!(cli.command, args, {
                    stdio: "inherit",
                    env: deps.env ?? process.env,
                  });
                  if (code !== 0) {
                    throw new Error(
                      `software deploy ${component} failed with exit status ${code}`,
                    );
                  }
                }
              },
            });
            const recordKey = deploymentRecordKey({
              component,
              profileOrChannel: deployTarget,
              deploymentId: finalRecord.deployment_id,
            });
            const summary = {
              component,
              tag: artifact.tag,
              artifact_id: artifact.artifact_id,
              duration: formatDurationMs(elapsedMsSince(targetStartedAt, deps)),
              source: artifact.source,
              ...(builtArtifact
                ? {
                    built: true,
                    built_component: builtArtifact.component,
                    built_artifact_id: builtArtifact.artifact_id,
                  }
                : {}),
              ...artifactSizeSummary(artifact.files),
              remote_manifest: artifact.remote_manifest,
              files: artifact.files.map((file) => file.url),
              ...(artifact.bundle_url
                ? { bundle_url: artifact.bundle_url }
                : {}),
              ...(artifact.bundle_sha256
                ? { bundle_sha256: artifact.bundle_sha256 }
                : {}),
              ...(rocketScope ? { rocket_scope: rocketScope } : {}),
              ...(rocketTarget?.bayService
                ? { bay_service: rocketTarget.bayService }
                : {}),
              ...(rocketTarget?.scaffoldOnly ? { scaffold_only: true } : {}),
              ...(hostBaseUrl ? { host_software_base_url: hostBaseUrl } : {}),
              ...(hostManagedComponents?.length === 1
                ? { host_managed_component: hostManagedComponents[0] }
                : {}),
              ...(hostManagedComponents?.length
                ? { host_managed_components: hostManagedComponents }
                : {}),
              ...(hostTarget
                ? {
                    host_rollout:
                      hostTarget.pacedFleetRollout === true ||
                      opts.rollout === true ||
                      component === "tools",
                  }
                : {}),
              ...(hostBootstrapUrl
                ? { host_bootstrap_url: hostBootstrapUrl }
                : {}),
              ...(hostBootstrapSha256Url
                ? { host_bootstrap_sha256_url: hostBootstrapSha256Url }
                : {}),
              ...(bootstrapPublishChannel
                ? {
                    host_bootstrap_publish_channel: bootstrapPublishChannel,
                  }
                : {}),
              ...(hostBootstrapTarget
                ? {
                    host_bootstrap_reconcile: opts.rollout === true,
                    ...(bootstrapScope
                      ? { host_bootstrap_scope: bootstrapScope }
                      : {}),
                  }
                : {}),
              ...(releaseProduct ? { release_product: releaseProduct } : {}),
              ...(releaseChannel ? { channel: releaseChannel } : {}),
              ...(releaseInstall ?? {}),
              ...(starInstall ?? {}),
              ...(starTarget ? { github_release: artifact.artifact_id } : {}),
              ...(releaseChannelManifestUrls
                ? { channel_manifests: releaseChannelManifestUrls }
                : {}),
              ...(toolsMinimalArtifact
                ? {
                    tools_minimal_artifact_id: toolsMinimalArtifact.artifact_id,
                    tools_minimal_tag: toolsMinimalArtifact.tag,
                    tools_minimal_source: toolsMinimalArtifact.source,
                    tools_minimal_size: artifactSizeSummary(
                      toolsMinimalArtifact.files,
                    ).size,
                    tools_minimal_size_bytes: artifactSizeSummary(
                      toolsMinimalArtifact.files,
                    ).size_bytes,
                  }
                : {}),
              ...(toolsMinimalChannelManifestUrls
                ? {
                    tools_minimal_channel_manifests:
                      toolsMinimalChannelManifestUrls,
                  }
                : {}),
              ...(releaseChannel === "stable"
                ? { latest_alias: "updated" }
                : {}),
              ...(releaseTarget ? {} : { profile: deployTarget }),
              deployment_id: finalRecord.deployment_id,
              deployment_record: `${config.publicBaseUrl}/${recordKey}`,
            };
            deploymentSummaries.push(summary);
            if (deployUnitCount === 1) {
              emitSuccess({ globals }, "software deploy", summary);
            } else if (!globals.json && globals.output !== "json") {
              emitSuccess({ globals }, "software deploy", summary);
            }
          }
        }
        if (deployUnitCount > 1) {
          const firstSummary = deploymentSummaries[0] ?? {};
          emitSuccess(
            { globals },
            "software deploy",
            components.length === 1
              ? {
                  component: components[0],
                  tag: firstSummary.tag,
                  artifact_id: firstSummary.artifact_id,
                  duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
                  targets: deployTargets,
                  deployments: deploymentSummaries,
                }
              : {
                  components,
                  selector: requestedSelector,
                  duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
                  targets: deployTargets,
                  deployments: deploymentSummaries,
                },
          );
        }
      },
    );

  software
    .command("history")
    .description("show deployment history for a component and profile/channel")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<profile-or-channel>", PROFILE_OR_CHANNEL_ARGUMENT)
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option("--limit <n>", "maximum rows to show", "10")
    .option("--wide", "show all deployment history columns in table output")
    .action(
      async (
        componentArg: string,
        profileOrChannel: string,
        opts: HistoryOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const target = `${profileOrChannel ?? ""}`.trim();
        if (!target) {
          throw new Error("software history requires <profile-or-channel>");
        }
        const limit = parseLimit(opts.limit);
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const index = await readDeploymentIndex({
          client,
          auth: config.auth,
          component,
          profileOrChannel: target,
        });
        const rows = index.deployments
          .slice(0, limit)
          .map(deploymentHistoryRow);
        const globals = command.optsWithGlobals() as any;
        if (globals.json || globals.output === "json") {
          emitSuccess({ globals }, "software history", {
            component,
            profile_or_channel: target,
            deployments: rows,
          });
          return;
        }
        printArrayTable(
          opts.wide ? rows : rows.map(narrowDeploymentHistoryRow),
        );
      },
    );

  software
    .command("rollback")
    .description(
      "redeploy a previously successful artifact from deployment history",
    )
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<profile-or-channel>", PROFILE_OR_CHANNEL_ARGUMENT)
    .argument("<artifact-id>", "previously deployed artifact id")
    .option("--local-store <path>", "local artifact store")
    .option("--config <path>", "rocket config path")
    .option("--remote <ssh-target>", "bay SSH target")
    .option("--api <url>", "site API URL")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .option(
      "--tools-minimal <tag-or-id>",
      "tools-minimal artifact selector for plus rollback; defaults to historical deployment metadata",
    )
    .option(
      "--bootstrap-scope <scope>",
      "with host-bootstrap --rollout: full, helpers, or environment",
    )
    .option(
      "--bootstrap-publish-channel <channel>",
      "with host-bootstrap: explicitly update the mutable latest or staging bootstrap channel",
    )
    .option(
      "--rollout",
      "for host-bootstrap, immediately reconcile all online hosts after updating desired state",
    )
    .action(
      async (
        componentArg: string,
        profileOrChannel: string,
        artifactId: string,
        opts: RollbackOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const target = `${profileOrChannel ?? ""}`.trim();
        const rollbackArtifactId = `${artifactId ?? ""}`.trim();
        if (!target) {
          throw new Error("software rollback requires <profile-or-channel>");
        }
        if (!rollbackArtifactId) {
          throw new Error("software rollback requires <artifact-id>");
        }
        if (!deps.runCommand) {
          throw new Error("software rollback requires runCommand dependency");
        }
        const startedAt = deps.now?.() ?? new Date();
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const index = await readDeploymentIndex({
          client,
          auth: config.auth,
          component,
          profileOrChannel: target,
        });
        const entry = successfulRollbackTarget({
          index,
          artifactId: rollbackArtifactId,
        });
        const record = await readDeploymentRecordByKey({
          client,
          config,
          key: entry.record_key,
        });
        const cli = currentCliInvocation();
        const args = rollbackDeployArgs({
          cliArgs: cli.args,
          component,
          artifactId: rollbackArtifactId,
          profileOrChannel: target,
          opts,
          record,
        });
        const code = await deps.runCommand(cli.command, args, {
          stdio: "inherit",
          env: deps.env ?? process.env,
        });
        if (code !== 0) {
          throw new Error(
            `software rollback ${component} failed with exit status ${code}`,
          );
        }
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software rollback",
          {
            component,
            profile_or_channel: target,
            artifact_id: rollbackArtifactId,
            tag: entry.tag,
            deployment_id: entry.deployment_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            redeploy_command: [cli.command, ...args].join(" "),
          },
        );
      },
    );

  software
    .command("smoke")
    .description("run a software smoke test")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<profile-or-channel>", PROFILE_OR_CHANNEL_ARGUMENT)
    .option("--api <url>", "site API URL")
    .option("--remote <ssh-target>", "bay SSH target")
    .option("--host <host>", "representative project host id or name")
    .option(
      "--check-timeout-ms <ms>",
      "per smoke check timeout in milliseconds",
    )
    .option(
      "--timeout <ms>",
      "deprecated alias for --check-timeout-ms; prefer --check-timeout-ms to avoid the global CLI --timeout option",
    )
    .action(
      async (
        componentArg: string,
        profileOrChannel: string,
        opts: SmokeOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const targetName = `${profileOrChannel ?? ""}`.trim();
        if (!targetName) {
          throw new Error("software smoke requires <profile-or-channel>");
        }
        const hostSmokeArtifact = hostArtifactForSmoke(component);
        const releaseSmokeTarget = releaseSmokeTargetForComponent(component);
        const starSmoke = isStarSmokeComponent(component);
        const hostBootstrapSmoke = isHostBootstrapSmokeComponent(component);
        if (
          !["static", "hub", "bay"].includes(component) &&
          !hostSmokeArtifact &&
          !releaseSmokeTarget &&
          !starSmoke &&
          !hostBootstrapSmoke
        ) {
          throw new Error(
            `software smoke ${component} is not implemented yet; currently supported: static, hub, bay, host-bootstrap, project-host, project, tools, cli, launchpad, plus, star`,
          );
        }
        const startedAt = deps.now?.() ?? new Date();
        const timeoutMs = resolveSmokeTimeoutMs({ opts, command });
        if (releaseSmokeTarget) {
          const checks = await smokeReleaseChannelChecks({
            component,
            channel: targetName,
            timeoutMs,
            deps,
          });
          assertSmokeChecks(checks);
          emitSuccess(
            { globals: command.optsWithGlobals() as any },
            "software smoke",
            {
              component,
              channel: targetName,
              public_base_url: softwarePublicBaseUrl(deps),
              duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
              checks,
            },
          );
          return;
        }
        if (starSmoke) {
          const checks = await smokeStarChecks({
            channel: targetName,
            deps,
          });
          assertSmokeChecks(checks);
          emitSuccess(
            { globals: command.optsWithGlobals() as any },
            "software smoke",
            {
              component,
              channel: targetName,
              duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
              checks,
            },
          );
          return;
        }
        if (hostBootstrapSmoke) {
          const checks = await smokeHostBootstrapChecks({
            timeoutMs,
            deps,
          });
          assertSmokeChecks(checks);
          emitSuccess(
            { globals: command.optsWithGlobals() as any },
            "software smoke",
            {
              component,
              profile: targetName,
              public_base_url: softwarePublicBaseUrl(deps),
              duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
              checks,
            },
          );
          return;
        }
        const target = resolveDeploySite({
          profile: targetName,
          opts,
          deps,
        });
        if (!target.api) {
          throw new Error(
            `software smoke ${component} requires an API URL from auth profile ${targetName} or --api`,
          );
        }
        if ((component === "hub" || component === "bay") && !deps.runCommand) {
          throw new Error("software smoke hub requires runCommand dependency");
        }
        const checks: SoftwareSmokeCheck[] = [];
        if (
          component === "static" ||
          component === "hub" ||
          component === "bay"
        ) {
          checks.push(
            ...(await smokeHttpChecks({
              api: target.api,
              timeoutMs,
              deps,
              checkFrontendAssets:
                component === "static" || component === "bay",
            })),
          );
        }
        if (component === "hub" || component === "bay") {
          const cli = currentCliInvocation();
          const routeProbeTimeoutMs = Math.min(timeoutMs, 10_000);
          const routeHealthHostId = `${
            opts.host ??
            (deps.env ?? process.env).COCALC_ROCKET_HEALTH_HOST_ID ??
            ""
          }`.trim();
          checks.push(
            await runTimedSmokeCheck(
              "host route health",
              async () => {
                const code = await deps.runCommand!(
                  cli.command,
                  [
                    ...cli.args,
                    "--profile",
                    targetName,
                    "rocket",
                    "health",
                    "host-routes",
                    "--api",
                    target.api!,
                    "--host-limit",
                    "1",
                    ...(routeHealthHostId
                      ? ["--host-id", routeHealthHostId]
                      : ["--site-funded-only"]),
                    "--request-timeout-ms",
                    `${routeProbeTimeoutMs}`,
                    "--rpc-timeout",
                    smokeRpcTimeout(routeProbeTimeoutMs),
                  ],
                  {
                    stdio: "inherit",
                    env: deps.env ?? process.env,
                    timeoutMs,
                  },
                );
                if (code !== 0) {
                  if (code === 124) {
                    throw new Error(
                      `rocket health host-routes timed out after ${timeoutMs}ms`,
                    );
                  }
                  throw new Error(
                    `rocket health host-routes failed with exit status ${code}`,
                  );
                }
                return "rocket health host-routes ok";
              },
              deps,
            ),
          );
        }
        if (hostSmokeArtifact) {
          checks.push(
            ...(await smokeHostSoftwareChecks({
              component,
              profile: targetName,
              host: opts.host,
              deps,
            })),
          );
        }
        assertSmokeChecks(checks);
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software smoke",
          {
            component,
            profile: targetName,
            api: target.api,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            checks,
          },
        );
      },
    );

  return software;
}
