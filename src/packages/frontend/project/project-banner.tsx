/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useProjectContext } from "./context";
import { CourseMembershipBanner } from "./course-membership-banner";
import { ComputeVmAgentGrantBanner } from "./compute-vm-agent-grant-banner";
import { ProjectDiskQuotaWarningBanner } from "./disk-usage/quota-warning-banner";
import { LegacyMigrationRestoreBanner } from "./legacy-migration-restore-banner";
import { ProjectRootfsUpgradeBanner } from "./rootfs-upgrade-banner";

export function ProjectWarningBanner() {
  const { project_id } = useProjectContext();

  return (
    <>
      <ComputeVmAgentGrantBanner projectId={project_id} />
      <ProjectDiskQuotaWarningBanner project_id={project_id} />
      <ProjectRootfsUpgradeBanner project_id={project_id} />
      <LegacyMigrationRestoreBanner project_id={project_id} />
      <CourseMembershipBanner project_id={project_id} />
    </>
  );
}
