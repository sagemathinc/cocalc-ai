/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { fromJS, type Map } from "immutable";
import type { CourseInfo } from "@cocalc/util/db-schema/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  createProjectFieldState,
  ensureProjectFieldValue,
  getCachedProjectFieldValue,
  useProjectField,
} from "./use-project-field";

export type ProjectCourseInfoMap = Map<string, any>;
type ProjectCourseInfo = CourseInfo | null;

const courseFieldState =
  createProjectFieldState<ProjectCourseInfoMap>("course");

function normalizeCourseInfo(
  course?: ProjectCourseInfo,
): ProjectCourseInfoMap | null {
  if (course == null) {
    return null;
  }
  return fromJS(course) as ProjectCourseInfoMap;
}

async function fetchProjectCourseInfo(
  project_id: string,
): Promise<ProjectCourseInfoMap | null> {
  return normalizeCourseInfo(
    await webapp_client.conat_client.hub.projects.getProjectCourseInfo({
      project_id,
    }),
  );
}

export function getCachedProjectCourseInfo(
  project_id: string,
): ProjectCourseInfoMap | null | undefined {
  return getCachedProjectFieldValue({
    state: courseFieldState,
    project_id,
  });
}

export async function ensureProjectCourseInfo(
  project_id: string,
): Promise<ProjectCourseInfoMap | null> {
  return await ensureProjectFieldValue({
    state: courseFieldState,
    project_id,
    fetch: fetchProjectCourseInfo,
  });
}

export function useProjectCourseInfo(
  project_id: string,
  initialCourse?: unknown,
) {
  const {
    value: course,
    refresh,
    setValue: setCourse,
  } = useProjectField({
    state: courseFieldState,
    project_id,
    projectMapField: "course",
    initialValue: initialCourse,
    fetch: fetchProjectCourseInfo,
  });

  return {
    course,
    refresh,
    setCourse,
  };
}
