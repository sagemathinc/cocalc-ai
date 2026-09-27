/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { serializeCollaborationReference } from "@cocalc/util/collaboration-references";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("isolated historical source integration", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => env?.close(), 60000);

  test("archived legacy participants and references reach another home without rewriting messages or losing identity on restart", async () => {
    const project_id = env.project;
    await env.hub("a", "ensureRoom", { project_id, request_id: randomUUID() });
    await env.retrySend("a", "initialize", { request_id: randomUUID() });
    const shared = await env.retrySend("a", "createThread", {
      request_id: randomUUID(),
      title: "Referenced discussion",
    });
    const referenced = {
      project_id,
      kind: "conversation" as const,
      resource_id: shared.thread_id,
    };
    const original = await env.worker("host").call("historicalFixture", {
      create: true,
      reference: serializeCollaborationReference({
        version: 1,
        target: referenced,
        display_fallback: "Referenced discussion",
      }),
    });
    await env.hub("a", "requestSource", {
      project_id,
      chat_path: original.chat_path,
    });
    const find = async (opts: object = {}) =>
      (await env.hub("b", "listResources", opts)).items.find(
        (item: any) => item.chat_path === original.chat_path,
      );
    await env.converge(async () => !!(await find({ scope: "for-you" })));
    const resource = await find({ person_id: env.accounts[1] });
    expect(resource).toBeDefined();
    expect(resource.reason).toBe("participation");
    expect(resource.participant_count).toBe(1000);
    expect(resource.participant_ids).not.toContain(env.accounts[1]);
    expect(resource.personal?.following ?? false).toBe(false);
    expect(resource.personal?.alias).toBeFalsy();
    expect(
      (await env.sql("b", "SELECT count(*) AS n FROM notification_targets"))[0]
        .n,
    ).toBe("0");
    const target = {
      project_id,
      kind: "conversation",
      resource_id: resource.resource_id,
    };
    const people: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 21; page++) {
      const result = await env.hub("b", "listParticipants", {
        ...target,
        limit: 50,
        ...(cursor ? { after: cursor } : {}),
      });
      expect(result.coverage).toBe("complete");
      expect(result.items.length).toBeLessThanOrEqual(50);
      people.push(...result.items.map((item: any) => item.account_id));
      cursor = result.next;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(new Set(people).size).toBe(1000);
    expect(people).toContain(env.accounts[1]);
    const references = await env.hub("b", "listReferences", target);
    expect(references.coverage).toBe("complete");
    expect(references.items).toHaveLength(1);
    expect(references.items[0].reference.target).toEqual(referenced);
    const before = await env.worker("host").call("historicalFixture");
    expect(before.digest).toBe(original.digest);
    expect(before.archivedMessages).toBe(999);
    expect(before.headMessages).toBe(1);
    expect(before.threadIds).toEqual([resource.thread_id]);
    expect(new Set(before.messageIds).size).toBe(original.originalMessages);
    expect(
      before.messageIds.every((id: unknown) => typeof id === "string" && !!id),
    ).toBe(true);

    await env.restartHost();
    await env.converge(async () => !!(await find({ scope: "for-you" })));
    const after = await env.worker("host").call("historicalFixture");
    expect(after).toEqual(before);
    expect((await find()).resource_id).toBe(resource.resource_id);
    expect((await env.hub("b", "listReferences", target)).items).toEqual(
      references.items,
    );
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
