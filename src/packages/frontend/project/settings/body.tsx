/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";

import { Space } from "antd";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { Customer, ProjectMap } from "@cocalc/frontend/todo-types";
import { useProjectCourseInfo } from "../use-project-course";
import {
  KUCALC_COCALC_COM,
  KUCALC_ON_PREMISES,
} from "@cocalc/util/db-schema/site-defaults";
import { is_different } from "@cocalc/util/misc";
import { NoNetworkProjectWarning } from "../warnings/no-network";
import { NonMemberProjectWarning } from "../warnings/non-member";
import { AboutBox } from "./about-box";
import { LauncherDefaults } from "./launcher-defaults";
import { Datastore } from "./datastore";
import { Environment } from "./environment";
import { HideDeleteBox } from "./hide-delete-box";
import { ManagedEgress } from "./managed-egress";
import { ProjectSettingsPageShell } from "./page-shell";
import { ProjectCapabilities } from "./project-capabilites";
import { ProjectControl } from "./project-control";
import { useRunQuota } from "./run-quota/hooks";
import SavingProjectSettingsError from "./saving-project-settings-error";
import { ProjectSettingsSectionCard } from "./section-card";
import type { ProjectSettingsNavItem } from "./section-nav";
import { ProjectSecrets } from "./secrets";
import { SSHPanel } from "./ssh";
import { Project } from "./types";
import { lite } from "@cocalc/frontend/lite";
import CreateBackup from "@cocalc/frontend/project/backups/create";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import CreateSnapshot from "@cocalc/frontend/project/snapshots/create";

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
  const kucalc = useTypedRedux("customize", "kucalc");
  const runQuota = useRunQuota(project_id, null);
  const { course } = useProjectCourseInfo(project_id);
  const datastore = useTypedRedux("customize", "datastore");
  const commercial = useTypedRedux("customize", "commercial");

  // get the description of the share, in case the project is being shared
  const id = project_id;

  const student = useStudentProjectFunctionality(project_id);
  const showSSH = !lite && !student.disableSSH;
  const showDatastore =
    kucalc === KUCALC_COCALC_COM ||
    (kucalc === KUCALC_ON_PREMISES && datastore);

  const isPaidStudentPayProject = !!course?.get("pay") && !!course.get("paid");
  const showNonMemberWarning =
    !isPaidStudentPayProject &&
    commercial &&
    runQuota != null &&
    !runQuota.member_host;
  const showNoInternetWarning =
    !isPaidStudentPayProject &&
    commercial &&
    runQuota != null &&
    !runQuota.network;
  const showCourseSection = course != null;
  const extraNavItems: ProjectSettingsNavItem[] = [];
  if (!lite) {
    extraNavItems.push(
      { id: "environment", icon: "terminal", label: "Environment" },
      {
        id: "network",
        icon: "network",
        label: "Network",
        warning: showNoInternetWarning || showNonMemberWarning,
      },
      { id: "recovery", icon: "life-ring", label: "Recovery" },
    );
    if (showSSH) {
      extraNavItems.push({ id: "ssh-api", icon: "key", label: "SSH & API" });
    }
  }
  if (showCourseSection) {
    extraNavItems.push({ id: "course", icon: "users", label: "Course" });
  }

  const navItems: ProjectSettingsNavItem[] = [
    { id: "overview", icon: "file-alt", label: "Overview" },
    { id: "resources", icon: "server", label: "Resources" },
    ...extraNavItems,
    { id: "danger", icon: "warning", label: "Danger Zone", danger: true },
  ];

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

      <ProjectSettingsSectionCard
        id="overview"
        icon="file-alt"
        title="Overview"
        description="Name, appearance, description, and project identity."
      >
        <AboutBox
          project_id={id}
          project_title={project.get("title") ?? ""}
          description={project.get("description") ?? ""}
          name={project.get("name")}
          actions={redux.getActions("projects")}
        />
      </ProjectSettingsSectionCard>

      <ProjectSettingsSectionCard
        id="resources"
        icon="server"
        title="Resources"
        description="Start, stop, move, archive, and inspect the runtime host and filesystem image."
      >
        <ProjectControl key="control" project={project} />
      </ProjectSettingsSectionCard>

      {!lite && (
        <ProjectSettingsSectionCard
          id="environment"
          icon="terminal"
          title="Environment"
          description="Defaults, environment variables, secrets, and software capability checks."
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <LauncherDefaults project_id={id} />
            <Environment key="environment" project_id={project_id} />
            <ProjectSecrets key="secrets" project_id={project_id} />
            <ProjectCapabilities
              key={"capabilities"}
              project={project}
              project_id={project_id}
            />
          </Space>
        </ProjectSettingsSectionCard>
      )}

      {!lite && (
        <ProjectSettingsSectionCard
          id="network"
          icon="network"
          title="Network"
          description="Outbound traffic, internet access, and metered egress signals."
        >
          <ManagedEgress project_id={project_id} />
        </ProjectSettingsSectionCard>
      )}

      {!lite && (
        <ProjectSettingsSectionCard
          id="recovery"
          icon="life-ring"
          title="Recovery"
          description="Create backups, snapshots, clones, and review persistent datastore information."
        >
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Space wrap>
              <CreateSnapshot />
              <CreateBackup />
              <CloneProject project_id={project_id} />
            </Space>
            {showDatastore && <Datastore key="datastore" project_id={id} />}
          </Space>
        </ProjectSettingsSectionCard>
      )}

      {!lite && !student.disableSSH && (
        <ProjectSettingsSectionCard
          id="ssh-api"
          icon="key"
          title="SSH & API"
          description="SSH access information and connection details for this project."
        >
          <SSHPanel key="ssh-keys" project={project} account_id={account_id} />
        </ProjectSettingsSectionCard>
      )}

      {showCourseSection && (
        <ProjectSettingsSectionCard
          id="course"
          icon="users"
          title="Course"
          description="Course-managed restrictions and inherited settings for this project."
        >
          {student.disableSSH ? (
            <p>SSH access is disabled by the course configuration.</p>
          ) : (
            <p>This project is linked to a course.</p>
          )}
        </ProjectSettingsSectionCard>
      )}

      <ProjectSettingsSectionCard
        id="danger"
        icon="warning"
        title="Danger Zone"
        description="Hide, archive, or delete this project. These actions are intentionally separated from normal settings."
        danger
      >
        <HideDeleteBox
          key="hide-delete"
          project={project}
          actions={redux.getActions("projects")}
        />
      </ProjectSettingsSectionCard>
    </ProjectSettingsPageShell>
  );
}, is_same);
