/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useProjectContext } from "./context";
import { CourseMembershipBanner } from "./course-membership-banner";

export function ProjectWarningBanner() {
  const { project_id } = useProjectContext();

  return <CourseMembershipBanner project_id={project_id} />;
}
