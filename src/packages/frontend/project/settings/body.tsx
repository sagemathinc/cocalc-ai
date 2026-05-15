/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";

import type { Customer, ProjectMap } from "@cocalc/frontend/todo-types";
import { is_different } from "@cocalc/util/misc";
import { NoNetworkProjectWarning } from "../warnings/no-network";
import { NonMemberProjectWarning } from "../warnings/non-member";
import { ProjectSettingsPageShell } from "./page-shell";
import SavingProjectSettingsError from "./saving-project-settings-error";
import { ProjectSettingsSectionCard } from "./section-card";
import { useProjectSettingsSections } from "./sections";
import type { Project } from "./types";

interface ReactProps {
  project_id: string;
  account_id?: string;
  project: Project;
  customer?: Customer;
  email_address?: string;
  project_map?: ProjectMap; // if this changes, then available upgrades change, so we may have to re-render, if editing upgrades.
}

const is_same = (prev: ReactProps, next: ReactProps) => {
  return !(
    is_different(prev, next, ["project", "project_map"]) ||
    (next.customer != null && !next.customer.equals(prev.customer))
  );
};

export const Body: React.FC<ReactProps> = React.memo((props: ReactProps) => {
  const { project_id, account_id, project } = props;
  const { sections, navItems, showNoInternetWarning, showNonMemberWarning } =
    useProjectSettingsSections({
      project_id,
      account_id,
      project,
      mode: "page",
    });

  return (
    <ProjectSettingsPageShell
      project_id={project_id}
      project={project}
      navItems={navItems}
      showNoInternetWarning={showNoInternetWarning}
      showNonMemberWarning={showNonMemberWarning}
    >
      {showNonMemberWarning ? <NonMemberProjectWarning /> : undefined}
      {showNoInternetWarning ? <NoNetworkProjectWarning /> : undefined}
      <SavingProjectSettingsError project_id={project_id} />

      {sections.map((section) => (
        <ProjectSettingsSectionCard
          key={section.id}
          id={section.id}
          icon={section.icon}
          title={section.title}
          description={section.description}
          danger={section.danger}
        >
          {section.children}
        </ProjectSettingsSectionCard>
      ))}
    </ProjectSettingsPageShell>
  );
}, is_same);
