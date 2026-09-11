import { createHash } from "node:crypto";
import { normalizeCoursePath } from "@cocalc/util/course-path";

export type CourseRow = Record<string, any>;
export type CourseMember = { account_id: string; group: string };
export type ReplacementProject = {
  project_id: string;
  course: CourseRow;
  members: CourseMember[];
};

export type ReplacementState = {
  course_project_id: string;
  path: string;
  student_id: string;
  old_account_id: string;
  new_account_id: string;
  rows: CourseRow[];
  instructors: CourseMember[];
  projects: ReplacementProject[];
};

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)),
        )
      : entry,
  );
}

export function replacementHash(state: ReplacementState): string {
  return `sha256:${createHash("sha256").update(canonical(state)).digest("hex")}`;
}

export function validateReplacement(state: ReplacementState): CourseRow {
  const { old_account_id: oldId, new_account_id: newId } = state;
  if (oldId === newId) throw Error("Old and new accounts must differ");
  if (state.instructors.some((m) => [oldId, newId].includes(m.account_id))) {
    throw Error("Cannot replace a student account that is also an instructor");
  }
  const students = state.rows.filter((r) => r.table === "students");
  const target = students.find((r) => r.student_id === state.student_id);
  if (
    !target ||
    target.deleted ||
    target.account_id !== oldId ||
    !target.project_id
  ) {
    throw Error(
      "Expected an active student with the specified old account and existing project",
    );
  }
  if (
    students.some(
      (r) =>
        r !== target &&
        ([oldId, newId].includes(r.account_id) ||
          r.project_id === target.project_id),
    )
  ) {
    throw Error(
      "Duplicate roster account or student project; reconcile explicitly first",
    );
  }
  const shared = state.rows.find(
    (r) => r.table === "settings",
  )?.shared_project_id;
  const expected = [target.project_id, ...(shared ? [shared] : [])].sort();
  if (
    new Set(expected).size !== expected.length ||
    expected.includes(state.course_project_id) ||
    canonical(expected) !==
      canonical(state.projects.map((p) => p.project_id).sort())
  ) {
    throw Error("Managed project set does not match the course");
  }
  for (const project of state.projects) {
    const course = project.course;
    const studentProject = project.project_id === target.project_id;
    if (
      !course ||
      course.project_id !== state.course_project_id ||
      normalizeCoursePath(course.path) !== normalizeCoursePath(state.path) ||
      course.type !== (studentProject ? "student" : "shared") ||
      (studentProject && course.account_id !== oldId)
    ) {
      throw Error(`Course association mismatch for ${project.project_id}`);
    }
    const oldMember = project.members.find((m) => m.account_id === oldId);
    const newMember = project.members.find((m) => m.account_id === newId);
    if (
      (oldMember && oldMember.group !== "collaborator") ||
      (newMember && newMember.group !== "collaborator")
    ) {
      throw Error(
        "Account replacement must not change an owner or viewer role",
      );
    }
  }
  return target;
}

export type ReplacementPorts = {
  inspect(): Promise<ReplacementState>;
  checkpoint(phase: string): Promise<void>;
  snapshot(project_id: string): Promise<void>;
  add(project_id: string, account_id: string): Promise<void>;
  setStudent(account_id: string): Promise<void>;
  setCourse(project_id: string, course: CourseRow): Promise<void>;
  remove(project_id: string, account_id: string): Promise<void>;
};

/** Uses existing authorized APIs; no account merge, file copy, or membership transfer. */
export async function applyReplacement(
  state: ReplacementState,
  expectedHash: string,
  ports: ReplacementPorts,
) {
  const target = validateReplacement(state);
  if (replacementHash(state) !== expectedHash)
    throw Error("Preview is stale; inspect again");
  await ports.checkpoint("prepared");
  for (const id of [
    state.course_project_id,
    ...state.projects.map((p) => p.project_id),
  ]) {
    await ports.snapshot(id);
  }
  // Snapshots and remote calls take time. Revalidate before the first access change.
  if (replacementHash(await ports.inspect()) !== expectedHash)
    throw Error("Course changed during backup; inspect again");
  await ports.checkpoint("adding-new-access");
  for (const p of state.projects) {
    if (!p.members.some((m) => m.account_id === state.new_account_id))
      await ports.add(p.project_id, state.new_account_id);
  }
  await ports.checkpoint("updating-roster");
  const expected = structuredClone(state);
  expected.projects.forEach((p) => {
    p.members = [
      ...p.members.filter((m) => m.account_id !== state.new_account_id),
      { account_id: state.new_account_id, group: "collaborator" },
    ].sort((a, b) => a.account_id.localeCompare(b.account_id));
  });
  if (replacementHash(await ports.inspect()) !== replacementHash(expected))
    throw Error(
      "Course or access changed during repair; inspect recovery journal",
    );
  await ports.setStudent(state.new_account_id);
  await ports.checkpoint("updating-course-metadata");
  expected.rows = expected.rows.map((r) =>
    r.table === "students" && r.student_id === state.student_id
      ? { ...r, account_id: state.new_account_id }
      : r,
  );
  if (replacementHash(await ports.inspect()) !== replacementHash(expected))
    throw Error(
      "Course changed before metadata update; inspect recovery journal",
    );
  const studentProject = state.projects.find(
    (p) => p.project_id === target.project_id,
  )!;
  await ports.setCourse(target.project_id, {
    ...studentProject.course,
    account_id: state.new_account_id,
  });
  expected.projects = expected.projects.map((p) => ({
    ...p,
    course:
      p.project_id === target.project_id
        ? { ...p.course, account_id: state.new_account_id }
        : p.course,
    members: [
      ...p.members.filter((m) => m.account_id !== state.new_account_id),
      { account_id: state.new_account_id, group: "collaborator" },
    ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
  }));
  if (replacementHash(await ports.inspect()) !== replacementHash(expected))
    throw Error(
      "Verification failed before removing old access; inspect recovery journal",
    );
  await ports.checkpoint("removing-old-access");
  for (const p of state.projects) {
    if (p.members.some((m) => m.account_id === state.old_account_id))
      await ports.remove(p.project_id, state.old_account_id);
  }
  expected.projects.forEach((p) => {
    p.members = p.members.filter((m) => m.account_id !== state.old_account_id);
  });
  if (replacementHash(await ports.inspect()) !== replacementHash(expected))
    throw Error("Final verification failed; inspect recovery journal");
  await ports.checkpoint("complete");
  return {
    student_id: state.student_id,
    project_ids: state.projects.map((p) => p.project_id),
    old_account_id: state.old_account_id,
    new_account_id: state.new_account_id,
  };
}
