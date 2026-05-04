import type {
  HostRuntimeDeploymentUpsert,
  HostRuntimeArtifact,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";

const MANAGED_COMPONENT_ARTIFACT: HostRuntimeArtifact = "project-host";

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
