import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rm,
  mkdtemp,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  publishHostCompatibilityArtifact,
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
    },
  ) => Promise<number>;
  runCommandOutput?: (
    command: string,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  r2Client?: SoftwareR2Client | (() => SoftwareR2Client);
  loadAuthConfig?: () => AuthConfig;
  fetch?: typeof fetch;
};

type BuildOptions = {
  localStore?: string;
  fromFile?: string;
  artifactName?: string;
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
};

type DeployOptions = {
  localStore?: string;
  envFile?: string;
  config?: string;
  remote?: string;
  api?: string;
  toolsMinimal?: string;
  build?: boolean;
};

type HistoryOptions = {
  envFile?: string;
  limit?: string;
};

type RollbackOptions = DeployOptions;

type SmokeOptions = {
  api?: string;
  remote?: string;
  host?: string;
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
const KNOWN_ROCKET_REMOTES: Record<string, string> = {
  "https://staging.cocalc.ai": "ubuntu@10.206.0.27",
  "https://cocalc.ai": "ubuntu@10.206.0.38",
  "https://delta.cocalc.ai": "ubuntu@10.206.15.209",
};

type SoftwareInfoComponent = SoftwareBuildComponent | SoftwareDeployComponent;

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
        "project-host",
        "project",
        "tools",
        "host-conat-router",
        "host-conat-persist",
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
        build: ["cocalc software build bay <tag>"],
        push: ["cocalc software push bay <tag-or-id>"],
        deploy: [`cocalc software deploy ${component} <tag-or-id> <profile>`],
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

  if (component === "host-conat-router" || component === "host-conat-persist") {
    const service = component.replace(/^host-/, "");
    return {
      component,
      title: `Project-host service: ${service}`,
      status: "deploy-only",
      artifact_component: "project-host",
      target_kind: "project-host-fleet",
      purpose: `Roll only the ${service} managed service on online project hosts using a project-host artifact.`,
      lifecycle: [
        "Build a project-host artifact.",
        "Publish host compatibility metadata.",
        `Set the desired managed component version for ${service}.`,
        "Reconcile online project hosts and wait for convergence.",
      ],
      commands: {
        build: ["cocalc software build project-host <tag>"],
        push: ["cocalc software push project-host <tag-or-id>"],
        deploy: [`cocalc software deploy ${component} <tag-or-id> <profile>`],
        smoke: ["cocalc software smoke project-host <profile>"],
        history: [`cocalc software history ${component} <profile>`],
        rollback: [
          `cocalc software rollback ${component} <profile> <artifact-id>`,
        ],
      },
      related_components: ["project-host"],
      operator_notes: [
        "This updates host deploy desired state and reconciles online hosts.",
        "Offline hosts converge when the host deployment machinery sees them later.",
      ],
      agent_notes: [
        "Resolve artifacts using artifact_component=project-host.",
        "Expect host deploy set and host deploy reconcile subprocesses during deploy.",
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
        title: "Bay static frontend assets",
        status: "build-and-deploy",
        artifact_component: "static",
        target_kind: "rocket-bay",
        purpose:
          "Ship browser frontend, public assets, webapp assets, and provider setup scripts to a bay.",
        lifecycle: [
          "Build static assets and package a static bundle.",
          "Push to R2 or let deploy push it.",
          "Deploy to a site profile with Rocket scope static.",
          "Smoke HTTP bootstrap and static asset endpoints.",
        ],
        commands: {
          build: ["cocalc software build static <tag>"],
          push: ["cocalc software push static <tag-or-id>"],
          deploy: ["cocalc software deploy static <tag-or-id> <profile>"],
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
          "Static bundle missing the expected manifest or frontend assets.",
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
          build: ["cocalc software build hub <tag>"],
          push: ["cocalc software push hub <tag-or-id>"],
          deploy: ["cocalc software deploy hub <tag-or-id> <profile>"],
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
          build: ["cocalc software build bay <tag>"],
          push: ["cocalc software push bay <tag-or-id>"],
          deploy: ["cocalc software deploy bay <tag-or-id> <profile>"],
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
          "Coordinate promotion with plus using cocalc software deploy plus --tools-minimal.",
        ],
        commands: {
          build: ["cocalc software build tools-minimal <tag>"],
          push: ["cocalc software push tools-minimal <tag-or-id>"],
          deploy: [
            "cocalc software deploy plus <tag-or-id> <channel> --tools-minimal <tools-tag-or-id>",
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
          build: ["cocalc software build star <tag>"],
          push: ["cocalc software push star <tag-or-id>"],
          deploy: ["cocalc software deploy star <tag-or-id> <channel>"],
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
    case "host-conat-router":
      return "This component targets the project-host-local Conat router managed component, not the bay router. It uses a project-host artifact and reconciles the managed component across online project hosts.";
    case "host-conat-persist":
      return "This component targets the project-host-local Conat persist managed component, not the bay persist service. It uses a project-host artifact and reconciles only that managed component across online hosts.";
    case "project-host":
      return "Project-host is the host agent/runtime that supervises projects, host services, RootFS operations, and host-side deployment state. Deploy it when project-host control logic changes.";
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
  component: "project-host" | "project" | "tools";
  title: string;
  purpose: string;
  upgradeArtifact: "project-host" | "project" | "tools";
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
      deploy: [`cocalc software deploy ${component} <tag-or-id> <profile>`],
      smoke: [`cocalc software smoke ${component} <profile>`],
      history: [`cocalc software history ${component} <profile>`],
      rollback: [
        `cocalc software rollback ${component} <profile> <artifact-id>`,
      ],
    },
    related_components:
      component === "project-host"
        ? ["host-conat-router", "host-conat-persist"]
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
              "cocalc software deploy plus <tag-or-id> <channel> --tools-minimal <tools-tag-or-id>",
            ]
          : [`cocalc software deploy ${component} <tag-or-id> <channel>`],
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
    "  cocalc software build hub <tag>",
    "  cocalc software deploy hub <tag-or-id> <profile>",
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
  const os = process.platform;
  const machine =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64" && os === "linux"
        ? "aarch64"
        : process.arch;
  return { machine, os };
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
    const artifactName = `cocalc-cli-${artifactId}-${machine}-${os}`;
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

function parseTimeoutMs(raw: string | undefined): number {
  const value = raw == null || raw.trim() === "" ? 15_000 : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("--timeout must be a positive number of milliseconds");
  }
  return Math.max(1, Math.floor(value));
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
}: {
  url: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<string> {
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
    return `HTTP ${response.status}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function smokeHttpChecks({
  api,
  timeoutMs,
  deps,
}: {
  api: string;
  timeoutMs: number;
  deps: SoftwareCommandDeps;
}): Promise<SoftwareSmokeCheck[]> {
  const checks: SoftwareSmokeCheck[] = [];
  for (const [check, path] of [
    ["homepage", "/"],
    ["static app shell", "/static/app.html"],
    ["webapp favicon", "/webapp/favicon.ico"],
    ["auth bootstrap", "/api/v2/auth/bootstrap"],
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
  if (component === "project") return "project-bundle";
  if (component === "tools") return "tools";
  return undefined;
}

function isStarSmokeComponent(component: SoftwareDeployComponent): boolean {
  return component === "star";
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
      binaryName: "cocalc" | "cocalc-launchpad" | "cocalc-plus";
    }
  | undefined {
  if (component === "cli") {
    return { artifactComponent: "cli", binaryName: "cocalc" };
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
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
} {
  const os = process.platform;
  if (os !== "linux" && os !== "darwin") {
    throw new Error(`unsupported release smoke OS: ${os}`);
  }
  const arch =
    process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "";
  if (arch !== "amd64" && arch !== "arm64") {
    throw new Error(`unsupported release smoke architecture: ${process.arch}`);
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
  platform: { os: "linux" | "darwin"; arch: "amd64" | "arm64" };
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
  if (component === "launchpad" || artifactUrl.endsWith(".tar.xz")) {
    const extractDir = join(workDir, "extract");
    await mkdir(extractDir, { recursive: true });
    const runCommandOutput = deps.runCommandOutput ?? defaultRunCommandOutput;
    const result = await runCommandOutput("tar", [
      "-C",
      extractDir,
      "-Jxf",
      artifactPath,
    ]);
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
  await chmod(executablePath, 0o755);
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
      await chmod(path, 0o755);
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

  checks.push(
    await runTimedSmokeCheck(
      "download artifact",
      async () => {
        workDir = await mkdtemp(join(tmpdir(), "cocalc-software-smoke-"));
        artifactPath = join(workDir, manifest.filename || "artifact");
        const body = await fetchSmokeBuffer({
          url: manifest.url,
          timeoutMs,
          deps,
        });
        const sha256 = sha256Buffer(body);
        if (sha256 !== manifest.sha256) {
          throw new Error(
            `artifact sha256 mismatch: expected ${manifest.sha256}, got ${sha256}`,
          );
        }
        await writeFile(artifactPath, body);
        return `${humanSize(body.length)} sha256:${sha256}`;
      },
      deps,
    ),
  );
  if (!artifactPath || !workDir) return checks;

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
          const result = await runCommandOutput(executable, ["--version"], {
            env: {
              ...(deps.env ?? process.env),
              ...releaseSmokeVersionEnv({
                component: target.artifactComponent,
                manifest,
              }),
            },
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
    !tagGenerated &&
    (await localTagExists({ manifests: existingManifests, tag }))
  ) {
    throw new Error(
      `software tag already exists locally for ${component}: ${tag}`,
    );
  }
  if (
    tagGenerated &&
    (await localTagExists({ manifests: existingManifests, tag }))
  ) {
    throw new Error(`generated software tag already exists locally: ${tag}`);
  }
  const startedAt = createdAt;
  const artifactId = createSoftwareArtifactId({
    createdAt,
    git,
    tag,
  });
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
    tagArg ? ` ${tagArg}` : ""
  }`;
  if (sourceFile) {
    sourceFiles = [{ source: sourceFile, name: artifactName }];
  }
  if (!sourceFile) {
    const info = rocketBuildInfo(component);
    const packageInfo = packageBuildInfo(component, artifactId);
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
  if (matches.length > 1) {
    throw new Error(
      `local software artifact selector is ambiguous for ${component}: ${selector}`,
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
  return manifests.filter(
    ({ manifest }) =>
      manifest.tag === selector || manifest.artifact_id === selector,
  );
}

function resolveSingleMatch<T>({
  matches,
  selector,
  label,
}: {
  matches: T[];
  selector: string;
  label: string;
}): T | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(`${label} selector is ambiguous: ${selector}`);
  }
  return matches[0];
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
  return entries.filter((entry) => remoteEntryMatchesSelector(entry, selector));
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

function normalizeApiOrigin(api: string | undefined): string | undefined {
  const raw = `${api ?? ""}`.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(
      raw.startsWith("http://") || raw.startsWith("https://")
        ? raw
        : `https://${raw}`,
    );
    return url.origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

function inferRocketRemote(api: string | undefined): string | undefined {
  const origin = normalizeApiOrigin(api);
  return origin ? KNOWN_ROCKET_REMOTES[origin] : undefined;
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
  account_id?: string;
  email_address?: string;
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
  const remote = opts.remote ?? inferRocketRemote(api);
  return {
    profileName,
    api,
    remote,
    account_id: authProfile?.account_id,
    email_address: authProfile?.email_address,
  };
}

function deployedBy({
  target,
  deps,
}: {
  target: ReturnType<typeof resolveDeploySite>;
  deps: SoftwareCommandDeps;
}): SoftwareDeploymentRecord["deployed_by"] {
  const env = deps.env ?? process.env;
  return {
    user: env.USER || env.LOGNAME || undefined,
    host: hostname(),
    account_id: target.account_id,
    email_address: target.email_address,
  };
}

function latestDeploySelector({
  selector,
  localManifests,
  remoteEntries,
}: {
  selector: string;
  localManifests: Awaited<ReturnType<typeof listLocalManifests>>;
  remoteEntries: SoftwareRemoteIndexEntry[];
}): string {
  if (!isSoftwareLatestSelector(selector)) {
    return selector;
  }
  const local = localManifests[0];
  const remote = [...remoteEntries].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  )[0];
  if (!local && !remote) {
    return selector;
  }
  if (
    local &&
    (!remote || local.manifest.created_at.localeCompare(remote.timestamp) >= 0)
  ) {
    return local.manifest.artifact_id;
  }
  return remote.artifact_id;
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
  const effectiveSelector = latestDeploySelector({
    selector,
    localManifests,
    remoteEntries: remoteIndex.artifacts,
  });
  const localMatch = resolveSingleMatch({
    matches: findLocalManifestMatches({
      manifests: localManifests,
      selector: effectiveSelector,
    }),
    selector: effectiveSelector,
    label: `local software artifact for ${component}`,
  });
  let remoteEntry = resolveSingleMatch({
    matches: findRemoteEntryMatches({
      entries: remoteIndex.artifacts,
      selector: effectiveSelector,
    }),
    selector: effectiveSelector,
    label: `remote software artifact for ${component}`,
  });

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

  throw new Error(
    `software artifact not found for ${component}: ${effectiveSelector}`,
  );
}

function hostDeployTargetForComponent(component: SoftwareDeployComponent):
  | {
      artifactComponent: SoftwareBuildComponent;
      upgradeArtifact: "project-host" | "project" | "tools";
      managedComponent?: "conat-router" | "conat-persist";
    }
  | undefined {
  if (
    component === "project-host" ||
    component === "project" ||
    component === "tools"
  ) {
    return {
      artifactComponent: component,
      upgradeArtifact: component,
    };
  }
  if (component === "host-conat-router") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponent: "conat-router",
    };
  }
  if (component === "host-conat-persist") {
    return {
      artifactComponent: "project-host",
      upgradeArtifact: "project-host",
      managedComponent: "conat-persist",
    };
  }
  return undefined;
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
  available_channels: string[];
} {
  const product = releaseProductForArtifactComponent(component);
  const envName = releaseChannelEnvForArtifactComponent(component);
  const installUrl = `${publicBaseUrl}/software/${product}/install.sh`;
  return {
    install_url: installUrl,
    install_channel_env: `${envName}=${channel}`,
    install_command: `curl -fsSL ${installUrl} | ${envName}=${channel} bash`,
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
  deps,
}: {
  component: SoftwareDeployComponent;
  artifactComponent: SoftwareBuildComponent;
  profileOrChannel: string;
  startedAt: Date;
  artifact: Awaited<ReturnType<typeof resolveDeployArtifact>>;
  target: ReturnType<typeof resolveDeploySite>;
  kind: SoftwareDeploymentRecord["target"]["kind"];
  details?: Record<string, unknown>;
  deps: SoftwareCommandDeps;
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
    deployed_by: deployedBy({ target, deps }),
    target: {
      kind,
      ...(kind === "release-channel"
        ? { channel: profileOrChannel }
        : { profile: profileOrChannel }),
      api: target.api,
      remote: target.remote,
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
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .argument("[tag]", "optional human tag; generated if omitted")
    .option("--local-store <path>", "local artifact store")
    .option(
      "--from-file <path>",
      "record an existing artifact file in the local software store",
    )
    .option("--artifact-name <name>", "override stored artifact file name")
    .option("--keep-build-dir", "keep temporary component build directory")
    .action(
      async (
        componentArg: string,
        tagArg: string | undefined,
        opts: BuildOptions,
        command: Command,
      ) => {
        const component = parseSoftwareBuildComponent(componentArg);
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
    .argument("<component>", BUILD_COMPONENT_ARGUMENT)
    .argument("<tag-or-id>", "artifact tag or id")
    .option("--local-store <path>", "local artifact store")
    .option(
      "--env-file <path>",
      "R2 credential env file",
      "/run/secrets/cocalc/rocket-software-env.sh",
    )
    .action(
      async (
        componentArg: string,
        selector: string,
        opts: PushOptions,
        command: Command,
      ) => {
        const component = parseSoftwareBuildComponent(componentArg);
        const startedAt = deps.now?.() ?? new Date();
        const localStore = resolveSoftwareLocalStore({
          option: opts.localStore,
          env: deps.env ?? process.env,
        });
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
        });
        const entry = manifestRemoteEntry({ manifest, config });
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software push",
          {
            component,
            tag: manifest.tag,
            artifact_id: manifest.artifact_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
            remote_manifest: entry.manifest_url,
            index: `${config.publicBaseUrl}/${indexKey(component)}`,
            files: entry.files.map((file) => file.url),
          },
        );
      },
    );

  software
    .command("deploy")
    .description("deploy or promote a software artifact")
    .argument("<component>", DEPLOY_COMPONENT_ARGUMENT)
    .argument("<tag-or-id>", "artifact tag or id")
    .argument("<profile-or-channel>", PROFILE_OR_CHANNEL_ARGUMENT)
    .option(
      "--build",
      "build the component tag before deploying; deploy-only service components build their underlying artifact component",
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
        componentArg: string,
        selector: string,
        profileOrChannel: string | undefined,
        opts: DeployOptions,
        command: Command,
      ) => {
        const component = parseSoftwareDeployComponent(componentArg);
        const deployTarget = `${profileOrChannel ?? ""}`.trim();
        if (!deployTarget) {
          throw new Error("software deploy requires <profile-or-channel>");
        }
        const startedAt = deps.now?.() ?? new Date();
        const rocketTarget = rocketDeployTargetForComponent(component);
        const hostTarget = hostDeployTargetForComponent(component);
        const releaseTarget = releaseDeployTargetForComponent(component);
        const starTarget = starDeployTargetForComponent(component);
        const releaseChannel =
          releaseTarget || starTarget
            ? validateSoftwareReleaseChannel(deployTarget)
            : undefined;
        const artifactComponent =
          rocketTarget?.artifactComponent ??
          hostTarget?.artifactComponent ??
          releaseTarget?.artifactComponent ??
          starTarget?.artifactComponent;
        if (!artifactComponent) {
          throw new Error(
            `software deploy ${component} is not wired yet; currently supported: static, hub, bay, bay-conat-router, bay-conat-persist, bay-frontdoor, bay-cloudflared, bay-scaffold, host-conat-router, host-conat-persist, project-host, project, tools, cli, launchpad, plus, star`,
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
        }
        const artifact = await resolveDeployArtifact({
          component: artifactComponent,
          selector,
          opts,
          deps,
        });
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
        const config = await resolveSoftwareRemoteConfig({
          env: deps.env ?? process.env,
          envFile: opts.envFile,
        });
        const client = softwareR2Client(deps);
        const cli = currentCliInvocation();
        let commandArgsList: string[][] = [];
        let rocketScope: string | undefined;
        let hostBaseUrl: string | undefined;
        let hostCompatUrl: string | undefined;
        let hostManagedComponent: string | undefined;
        let releaseProduct: string | undefined;
        let releaseInstall: ReturnType<typeof releaseInstallInfo> | undefined;
        let releaseChannelManifestUrls: string[] | undefined;
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
          const compat = await publishHostCompatibilityArtifact({
            client,
            config,
            entry: artifact.remote_entry,
          });
          hostBaseUrl = compat.base_url;
          hostCompatUrl = compat.urls.join("\n");
          hostManagedComponent = hostTarget.managedComponent;
          targetKind = "project-host-fleet";
          commandArgsList = [
            [
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
              "--wait",
            ],
          ];
          if (hostManagedComponent) {
            const reason = `software-deploy-${component}`;
            commandArgsList.push(
              [
                ...cli.args,
                "--profile",
                deployTarget,
                "host",
                "deploy",
                "set",
                "--global",
                "--component",
                hostManagedComponent,
                "--desired-version",
                artifact.artifact_id,
                "--policy",
                "restart_now",
                "--reason",
                reason,
              ],
              [
                ...cli.args,
                "--profile",
                deployTarget,
                "host",
                "deploy",
                "reconcile",
                "--all-online",
                "--component",
                hostManagedComponent,
                "--reason",
                reason,
                "--wait",
              ],
            );
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
            toolsMinimalSelector = `${opts.toolsMinimal ?? selector}`.trim();
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
          startedAt,
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
            ...(artifact.bundle_url ? { bundle_url: artifact.bundle_url } : {}),
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
            ...(hostManagedComponent
              ? { host_managed_component: hostManagedComponent }
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
          deps,
        });
        const finalRecord = await runWithDeploymentHistory({
          record,
          client,
          config,
          deps,
          run: async () => {
            if (releaseTarget) {
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
                    COCALC_STAR_GIT_REVISION: artifact.remote_entry.git.commit,
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
        emitSuccess(
          { globals: command.optsWithGlobals() as any },
          "software deploy",
          {
            component,
            tag: artifact.tag,
            artifact_id: artifact.artifact_id,
            duration: formatDurationMs(elapsedMsSince(startedAt, deps)),
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
            ...(artifact.bundle_url ? { bundle_url: artifact.bundle_url } : {}),
            ...(artifact.bundle_sha256
              ? { bundle_sha256: artifact.bundle_sha256 }
              : {}),
            ...(rocketScope ? { rocket_scope: rocketScope } : {}),
            ...(rocketTarget?.bayService
              ? { bay_service: rocketTarget.bayService }
              : {}),
            ...(rocketTarget?.scaffoldOnly ? { scaffold_only: true } : {}),
            ...(hostBaseUrl ? { host_software_base_url: hostBaseUrl } : {}),
            ...(hostManagedComponent
              ? { host_managed_component: hostManagedComponent }
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
            ...(releaseChannel === "stable" ? { latest_alias: "updated" } : {}),
            ...(releaseTarget ? {} : { profile: deployTarget }),
            deployment_id: finalRecord.deployment_id,
            deployment_record: `${config.publicBaseUrl}/${recordKey}`,
          },
        );
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
        printArrayTable(rows);
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
    .option("--timeout <ms>", "per HTTP check timeout in milliseconds", "15000")
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
        if (
          !["static", "hub", "bay"].includes(component) &&
          !hostSmokeArtifact &&
          !releaseSmokeTarget &&
          !starSmoke
        ) {
          throw new Error(
            `software smoke ${component} is not implemented yet; currently supported: static, hub, bay, project-host, project, tools, cli, launchpad, plus, star`,
          );
        }
        const startedAt = deps.now?.() ?? new Date();
        const timeoutMs = parseTimeoutMs(opts.timeout);
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
            })),
          );
        }
        if (component === "hub" || component === "bay") {
          const cli = currentCliInvocation();
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
                  ],
                  {
                    stdio: "inherit",
                    env: deps.env ?? process.env,
                  },
                );
                if (code !== 0) {
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
