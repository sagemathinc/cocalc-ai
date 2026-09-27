/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { LiteCollaborators } from "./index";
import type { CollaborationResource } from "@cocalc/util/collaborators";

test("100,000 indexed resources retain bounded searchable pages without project/filesystem services", async () => {
  const project_id = "11111111-1111-4111-8111-111111111111";
  const account_id = "human";
  const store = new LiteCollaborators({
    filename: ":memory:",
    project_id,
    account_id,
    isEnabled: () => true,
  });
  try {
    for (let batch = 0; batch < 20; batch++) {
      const chat_path = `/home/user/source-${batch}.chat`;
      const { epoch } = await store.registerSource({
        project_id,
        chat_path,
        registration_id: `writer-${batch}`,
        expected_epoch: null,
      });
      const resources: CollaborationResource[] = Array.from(
        { length: 5000 },
        (_, i) => {
          const id = `${batch * 5000 + i}`.padStart(6, "0");
          return {
            project_id,
            chat_path,
            kind: "conversation",
            resource_id: id,
            thread_id: id,
            title: `Topic ${id}`,
            participant_ids: [],
            created_at: 1,
            updated_at: 1,
            activity: 1,
          };
        },
      );
      await store.ingest({
        snapshot: { project_id, chat_path, epoch, sequence: 1, resources },
      });
    }
    const first = await store.api.listResources({ account_id });
    expect(first.items).toHaveLength(50);
    expect(first.items[0].resource_id).toBe("000000");
    expect(first.next).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    const second = await store.api.listResources({
      account_id,
      after: first.next,
    });
    expect(second.items[0].resource_id).toBe("000050");
    const search = await store.api.listResources({
      account_id,
      search: "099999",
    });
    expect(search.items.map((item) => item.resource_id)).toEqual(["099999"]);
    expect(search.coverage).toBe("partial");
  } finally {
    store.close();
  }
}, 60_000);
