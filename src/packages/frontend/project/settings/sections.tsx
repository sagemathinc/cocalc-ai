/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import type { ReactNode } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { lite } from "@cocalc/frontend/lite";
import { ProjectCollaboratorsContent } from "@cocalc/frontend/project/page/project-collaborators";
import CreateBackup from "@cocalc/frontend/project/backups/create";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import CreateSnapshot from "@cocalc/frontend/project/snapshots/create";
import {
  KUCALC_COCALC_COM,
  KUCALC_ON_PREMISES,
} from "@cocalc/util/db-schema/site-defaults";

import { useProjectCourseInfo } from "../use-project-course";
import { AboutBox } from "./about-box";
import { Datastore } from "./datastore";
import { Environment } from "./environment";
import { HideDeleteBox } from "./hide-delete-box";
import { LauncherDefaults } from "./launcher-defaults";
import { ManagedEgress } from "./managed-egress";
import { ProjectCapabilities } from "./project-capabilites";
import { ProjectControl } from "./project-control";
import { useRunQuota } from "./run-quota/hooks";
import { ProjectSecrets } from "./secrets";
import type { ProjectSettingsNavItem } from "./section-nav";
import { SSHPanel } from "./ssh";
import type { Project } from "./types";

export type ProjectSettingsLayoutMode = "page" | "flyout";

export interface ProjectSettingsSection extends ProjectSettingsNavItem {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  extra?: ReactNode;
}

interface Options {
  project_id: string;
  account_id?: string;
  project?: Project;
  mode: ProjectSettingsLayoutMode;
  datastoreReload?: number;
  environmentExtra?: ReactNode;
  recoveryExtra?: ReactNode;
}

export function useProjectSettingsSections({
  project_id,
  account_id,
  project,
  mode,
  datastoreReload,
  environmentExtra,
  recoveryExtra,
}: Options): {
  sections: ProjectSettingsSection[];
  navItems: ProjectSettingsNavItem[];
  showNoInternetWarning: boolean;
  showNonMemberWarning: boolean;
} {
  const kucalc = useTypedRedux("customize", "kucalc");
  const runQuota = useRunQuota(project_id, null);
  const { course } = useProjectCourseInfo(project_id);
  const datastore = useTypedRedux("customize", "datastore");
  const commercial = useTypedRedux("customize", "commercial");
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
  const flyout = mode === "flyout";
  const sectionGap = flyout ? 10 : 16;
  const componentMode = flyout ? "flyout" : undefined;

  if (project == null) {
    return {
      sections: [],
      navItems: [],
      showNoInternetWarning,
      showNonMemberWarning,
    };
  }

  const sections: ProjectSettingsSection[] = [
    {
      id: "overview",
      icon: "file-alt",
      label: "Overview",
      title: "Overview",
      description: "Name, appearance, description, and project identity.",
      children: (
        <AboutBox
          mode={componentMode}
          project_id={project_id}
          project_title={project.get("title") ?? ""}
          description={project.get("description") ?? ""}
          name={project.get("name")}
          actions={redux.getActions("projects")}
        />
      ),
    },
    {
      id: "resources",
      icon: "server",
      label: "Resources",
      title: "Resources",
      description:
        "Start, stop, move, archive, and inspect the runtime host and filesystem image.",
      children: <ProjectControl project={project} mode={componentMode} />,
    },
  ];

  if (!lite) {
    sections.push(
      {
        id: "people",
        icon: "users",
        label: "People",
        title: "People",
        description:
          "Invite collaborators, review pending invitations, and manage human access to this project.",
        children: (
          <ProjectCollaboratorsContent
            project_id={project_id}
            layout="flyout"
          />
        ),
      },
      {
        id: "environment",
        icon: "terminal",
        label: "Environment",
        title: "Environment",
        description:
          "Defaults, environment variables, secrets, and software capability checks.",
        className: "cc-project-flyout-settings-panel",
        extra: environmentExtra,
        children: (
          <Space
            direction="vertical"
            size={sectionGap}
            style={{ width: "100%" }}
          >
            <LauncherDefaults project_id={project_id} />
            <Environment project_id={project_id} mode={componentMode} />
            <ProjectSecrets project_id={project_id} mode={componentMode} />
            <ProjectCapabilities
              project={project}
              project_id={project_id}
              mode={componentMode}
            />
          </Space>
        ),
      },
      {
        id: "network",
        icon: "network",
        label: "Network",
        title: "Network",
        description:
          "Outbound traffic, internet access, and metered egress signals.",
        warning: showNoInternetWarning || showNonMemberWarning,
        className: "cc-project-flyout-settings-panel",
        children: <ManagedEgress project_id={project_id} />,
      },
      {
        id: "recovery",
        icon: "life-ring",
        label: "Recovery",
        title: "Recovery",
        description:
          "Create backups, snapshots, clones, and review persistent datastore information.",
        className: "cc-project-flyout-settings-panel",
        extra: showDatastore ? recoveryExtra : undefined,
        children: (
          <Space
            direction="vertical"
            size={sectionGap}
            style={{ width: "100%" }}
          >
            <Space wrap>
              <CreateSnapshot />
              <CreateBackup />
              <CloneProject project_id={project_id} />
            </Space>
            {showDatastore && (
              <Datastore
                project_id={project_id}
                mode={componentMode}
                reloadTrigger={datastoreReload}
              />
            )}
          </Space>
        ),
      },
    );
  } else {
    sections.push({
      id: "recovery",
      icon: "life-ring",
      label: "Recovery",
      title: "Recovery",
      description: "Create a copy of this project.",
      children: <CloneProject project_id={project_id} />,
    });
  }

  if (showSSH) {
    sections.push({
      id: "ssh-api",
      icon: "key",
      label: "SSH & API",
      title: "SSH & API",
      description:
        "SSH access information and connection details for this project.",
      children: (
        <SSHPanel
          mode={componentMode}
          project={project}
          account_id={account_id}
        />
      ),
    });
  }

  if (showCourseSection) {
    sections.push({
      id: "course",
      icon: "users",
      label: "Course",
      title: "Course",
      description:
        "Course-managed restrictions and inherited settings for this project.",
      children: student.disableSSH ? (
        <p>SSH access is disabled by the course configuration.</p>
      ) : (
        <p>This project is linked to a course.</p>
      ),
    });
  }

  sections.push({
    id: "danger",
    icon: "warning",
    label: "Danger Zone",
    title: "Danger Zone",
    description:
      "Hide, archive, or delete this project. These actions are intentionally separated from normal settings.",
    danger: true,
    children: (
      <HideDeleteBox
        project={project}
        actions={redux.getActions("projects")}
        mode={componentMode}
      />
    ),
  });

  return {
    sections,
    navItems: sections.map(
      ({ id, icon, label, warning, danger }): ProjectSettingsNavItem => ({
        id,
        icon,
        label,
        warning,
        danger,
      }),
    ),
    showNoInternetWarning,
    showNonMemberWarning,
  };
}
