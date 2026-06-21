/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { DocsEntry } from "../types";
import { docsIcon } from "../helpers";
import {
  COURSE_ASSIGNMENT_BODY,
  COURSE_RESTRICT_STUDENT_PROJECTS_BODY,
  COURSE_SHARED_PROJECT_BODY,
  COURSE_STUDENT_PROJECT_ROOTFS_BODY,
  COURSE_STUDENT_PAY_BODY,
  COURSE_WORKFLOW_BODY,
  NBGRADER_BODY,
} from "../content";

export const TEACHING_ENTRIES: DocsEntry[] = [
  {
    audiences: ["agents", "instructors"],
    body: COURSE_WORKFLOW_BODY.trim(),
    category: "Teaching",
    id: "teaching.course-workflow",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-25",
    noActionReason:
      "Course workflows are course-scoped; the action would need a selected .course file.",
    slug: "teaching/course-workflow",
    status: "ready",
    summary:
      "Run computational courses with student projects, assignments, collection, grading, and feedback.",
    title: "Teach a course",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_STUDENT_PAY_BODY.trim(),
    category: "Teaching",
    id: "teaching.student-pay",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-06-21",
    noActionReason:
      "Student pay is configured inside a selected .course file and depends on course-specific membership settings.",
    searchKeywords:
      "student pay course payment options grace period course start date site license instructor pays course membership",
    slug: "teaching/student-pay",
    status: "ready",
    summary:
      "Configure student pay, instructor-paid seats, site licenses, course start dates, and grace periods.",
    title: "Configure course student pay",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_RESTRICT_STUDENT_PROJECTS_BODY.trim(),
    category: "Teaching",
    id: "teaching.restrict-student-projects",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-06-21",
    noActionReason:
      "Student project restrictions are configured inside a selected .course file.",
    searchKeywords:
      "restrict student projects course disable actions uploads collaborators terminals ai jupyterlab vscode pluto rserver exams",
    slug: "teaching/restrict-student-projects",
    status: "ready",
    summary:
      "Explain each student-project restriction option and what it really disables.",
    title: "Restrict student projects",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_SHARED_PROJECT_BODY.trim(),
    category: "Teaching",
    id: "teaching.shared-project",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-06-21",
    noActionReason:
      "Shared projects are created from a selected .course file and depend on that course roster.",
    searchKeywords:
      "course shared project students collaborators write access labs common workspace",
    slug: "teaching/shared-project",
    status: "ready",
    summary:
      "Use a common writable project shared by all students, instructors, and TAs.",
    title: "Course shared project",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_STUDENT_PROJECT_ROOTFS_BODY.trim(),
    category: "Teaching",
    id: "teaching.student-project-rootfs",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-06-21",
    noActionReason:
      "Student project RootFS images are configured inside a selected .course file.",
    searchKeywords:
      "course student project rootfs image software environment managed image apply existing projects restart",
    slug: "teaching/student-project-rootfs",
    status: "ready",
    summary:
      "Choose and roll out managed RootFS images for course student projects.",
    title: "Student project RootFS images",
  },
  {
    audiences: ["agents", "instructors"],
    body: COURSE_ASSIGNMENT_BODY.trim(),
    category: "Teaching",
    id: "teaching.create-assignment",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-24",
    noActionReason:
      "Assignment creation is course-scoped; projects can contain many .course files or none.",
    slug: "teaching/create-assignment",
    status: "ready",
    summary:
      "Assign, collect, grade, and return computational work in student projects.",
    title: "Create a course assignment",
  },
  {
    audiences: ["agents", "instructors"],
    body: NBGRADER_BODY.trim(),
    category: "Teaching",
    id: "teaching.nbgrader",
    image: docsIcon(
      "/public/docs/course-assignment-ede60e1a.webp",
      "Course assignments sent to student project folders",
    ),
    lastReviewed: "2026-05-25",
    noActionReason:
      "nbgrader setup is a course-and-notebook workflow, not a single safe UI destination.",
    slug: "teaching/nbgrader",
    status: "ready",
    summary:
      "Use nbgrader for structured Jupyter notebook grading in CoCalc courses.",
    title: "Use nbgrader",
  },
];
