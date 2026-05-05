import type {
  HostRuntimeDeploymentUpsert,
  HostRuntimeArtifact,
  HostSoftwareArtifact,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";

const MANAGED_COMPONENT_ARTIFACT: HostRuntimeArtifact = "project-host";

function normalizeSoftwareArtifact(
  artifact: string | HostSoftwareArtifact | undefined,
): HostSoftwareArtifact | undefined {
  if (artifact === "project-bundle") return "project";
  if (
    artifact === "project-host" ||
    artifact === "project" ||
    artifact === "tools" ||
    artifact === "bootstrap-environment"
  ) {
    return artifact;
  }
  return undefined;
}

export function shouldAlignRuntimeStackForSoftwareArtifacts({
  artifacts,
  alignRuntimeStack = false,
}: {
  artifacts: Array<string | HostSoftwareArtifact>;
  alignRuntimeStack?: boolean;
}): boolean {
  if (alignRuntimeStack) {
    return true;
  }
  return artifacts.some(
    (artifact) => normalizeSoftwareArtifact(artifact) === "project-host",
  );
}

export function runtimeDeploymentsForManagedComponentVersion({
  component,
  desired_version,
  rollout_reason,
}: {
  component: ManagedComponentKind;
  desired_version?: string;
  rollout_reason?: string;
}): HostRuntimeDeploymentUpsert[] {
  const version = `${desired_version ?? ""}`.trim();
  if (!version) {
    return [];
  }
  return [
    {
      target_type: "artifact",
      target: MANAGED_COMPONENT_ARTIFACT,
      desired_version: version,
      rollout_reason,
    },
    {
      target_type: "component",
      target: component,
      desired_version: version,
      rollout_reason,
    },
  ];
}
