/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { createLro, getLro, updateLro } from "@cocalc/server/lro/lro-db";
import {
  addStudentsToScheduledCollection,
  SCHEDULED_COLLECTION_KIND,
} from "./course-collect-schedule";

beforeAll(async () => {
  await before();
}, 15_000);
afterAll(after);

function item(student_id: string) {
  return {
    student_id,
    student_project_id: uuid(),
    src_path: "hw",
    dest_path: `hw-collect/${student_id}`,
  };
}

async function scheduled(students: string[]) {
  const course_project_id = uuid();
  const assignment_id = uuid();
  const run_at = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const op = await createLro({
    kind: SCHEDULED_COLLECTION_KIND,
    scope_type: "project",
    scope_id: course_project_id,
    input: {
      course_project_id,
      assignment_id,
      items: students.map(item),
      options: { recursive: true },
      run_at,
    },
    dedupe_key: `course-collect:${course_project_id}:${assignment_id}:${run_at}`,
    expires_at: new Date(Date.parse(run_at) + 7 * 24 * 3600 * 1000),
    status: "queued",
  });
  return { op_id: op.op_id, course_project_id, assignment_id };
}

async function students(op_id: string): Promise<string[]> {
  const op = await getLro(op_id);
  return (op?.input?.items ?? []).map((x: any) => x.student_id).sort();
}

describe("adding students to a scheduled collection", () => {
  it("adds students assigned later and keeps those already listed", async () => {
    const s = await scheduled(["s1"]);
    const first = (await getLro(s.op_id))?.input?.items?.[0];
    const result = await addStudentsToScheduledCollection({
      ...s,
      items: [item("s1"), item("s2"), item("s3")],
      max_items: 500,
    });
    expect(result).toEqual({ updated: true, item_count: 3 });
    expect(await students(s.op_id)).toEqual(["s1", "s2", "s3"]);
    // the existing entry for s1 is kept as it was
    expect((await getLro(s.op_id))?.input?.items?.[0]).toEqual(first);
    expect((await getLro(s.op_id))?.status).toBe("queued");
  });

  it("merges concurrent additions from several browsers", async () => {
    const s = await scheduled(["s1"]);
    await Promise.all([
      addStudentsToScheduledCollection({
        ...s,
        items: [item("s2")],
        max_items: 500,
      }),
      addStudentsToScheduledCollection({
        ...s,
        items: [item("s3")],
        max_items: 500,
      }),
      addStudentsToScheduledCollection({
        ...s,
        items: [item("s2"), item("s4")],
        max_items: 500,
      }),
    ]);
    expect(await students(s.op_id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("adds a student listed twice in one request only once (the first entry)", async () => {
    const s = await scheduled(["s1"]);
    const first = { ...item("s2"), dest_path: "first" };
    const result = await addStudentsToScheduledCollection({
      ...s,
      items: [first, { ...item("s2"), dest_path: "second" }, item("s3")],
      max_items: 500,
    });
    expect(result).toEqual({ updated: true, item_count: 3 });
    const items = (await getLro(s.op_id))?.input?.items ?? [];
    expect(items.map((x: any) => x.student_id)).toEqual(["s1", "s2", "s3"]);
    expect(items[1].dest_path).toBe("first");
  });

  it("changes nothing once the collection is no longer queued", async () => {
    for (const status of ["running", "canceled", "succeeded"] as const) {
      const s = await scheduled(["s1"]);
      await updateLro({ op_id: s.op_id, status });
      await expect(
        addStudentsToScheduledCollection({
          ...s,
          items: [item("s2")],
          max_items: 500,
        }),
      ).resolves.toEqual({ updated: false });
      expect(await students(s.op_id)).toEqual(["s1"]);
    }
  });

  it("only changes the scheduled collection of the given course and assignment", async () => {
    const s = await scheduled(["s1"]);
    for (const wrong of [
      { course_project_id: uuid() },
      { assignment_id: uuid() },
    ]) {
      await expect(
        addStudentsToScheduledCollection({
          ...s,
          ...wrong,
          items: [item("s2")],
          max_items: 500,
        }),
      ).resolves.toEqual({ updated: false });
    }
    expect(await students(s.op_id)).toEqual(["s1"]);
  });

  it("refuses to grow a collection beyond the maximum", async () => {
    const s = await scheduled(["s1", "s2"]);
    await expect(
      addStudentsToScheduledCollection({
        ...s,
        items: [item("s3")],
        max_items: 2,
      }),
    ).resolves.toEqual({ updated: false });
    expect(await students(s.op_id)).toEqual(["s1", "s2"]);
  });
});
