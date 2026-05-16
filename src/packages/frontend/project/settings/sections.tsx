/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Space } from "antd";
import { lazy, Suspense, type ReactNode } from "react";

import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { useStudentProjectFunctionality } from "@cocalc/frontend/course";
import { lite } from "@cocalc/frontend/lite";
import { ProjectCollaboratorsContent } from "@cocalc/frontend/project/page/project-collaborators";
import CloneProject from "@cocalc/frontend/project/explorer/clone";
import { SettingBox } from "@cocalc/frontend/components";
import {
  KUCALC_COCALC_COM,
  KUCALC_ON_PREMISES,
} from "@cocalc/util/db-schema/site-defaults";

import { useProjectCourseInfo } from "../use-project-course";
import { AboutBox } from "./about-box";
import { Environment } from "./environment";
import { ProjectLocationBox } from "./hide-delete-box";
import { LauncherDefaults } from "./launcher-defaults";
import { ManagedEgress } from "./managed-egress";
import { ProjectCapabilities } from "./project-capabilites";
import { ProjectControl } from "./project-control";
import { RecoveryPanel } from "./recovery-panel";
import RootFilesystemImage from "./root-filesystem-image";
import { useRunQuota } from "./run-quota/hooks";
import { ProjectSecrets } from "./secrets";
import type { ProjectSettingsNavItem } from "./section-nav";
import { SSHPanel } from "./ssh";
import type { Project } from "./types";

const CourseRuntimeSponsorSummary = lazy(async () => {
  const module = await import("./runtime-sponsor-controls");
  return { default: module.CourseRuntimeSponsorSummary };
});

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
  recoveryExtra?: ReactNode;
}

export function useProjectSettingsSections({
  project_id,
  account_id,
  project,
  mode,
  datastoreReload,
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
  const embeddedInSection = true;

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
          embedded={embeddedInSection}
        />
      ),
    },
    {
      id: "resources",
      icon: "server",
      label: "Runtime",
      title: "Runtime",
      description:
        "Control the active project process and review host diagnostics.",
      children: (
        <ProjectControl
          project={project}
          mode={componentMode}
          showRootFilesystemImage={false}
          embedded={embeddedInSection}
        />
      ),
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
          "Launcher defaults, environment variables, secrets, software capability checks, and the root filesystem image.",
        className: "cc-project-flyout-settings-panel",
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
            <SettingBox title="Root Filesystem Image" icon="disk-drive">
              <RootFilesystemImage />
            </SettingBox>
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
        children: (
          <ManagedEgress project_id={project_id} embedded={embeddedInSection} />
        ),
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
          <RecoveryPanel
            project_id={project_id}
            project={project}
            mode={componentMode}
            showDatastore={showDatastore}
            datastoreReload={datastoreReload}
          />
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
      id: "ssh",
      icon: "key",
      label: "SSH",
      title: "SSH",
      description:
        "SSH access information and connection details for this project.",
      children: (
        <SSHPanel
          mode={componentMode}
          project={project}
          account_id={account_id}
          embedded={embeddedInSection}
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
      children: (
        <Space direction="vertical" size={sectionGap} style={{ width: "100%" }}>
          {student.disableSSH ? (
            <p>SSH access is disabled by the course configuration.</p>
          ) : (
            <p>This project is linked to a course.</p>
          )}
          <Suspense fallback={null}>
            <CourseRuntimeSponsorSummary project_id={project_id} />
          </Suspense>
        </Space>
      ),
    });
  }

  sections.push({
    id: "location",
    icon: "servers",
    label: "Location",
    title: "Location",
    description:
      "Hide, move, archive, or delete this project. These actions change where the project is available.",
    children: (
      <ProjectLocationBox
        project={project}
        actions={redux.getActions("projects")}
        mode={componentMode}
        embedded={embeddedInSection}
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
