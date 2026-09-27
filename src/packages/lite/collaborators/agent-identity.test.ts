import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollaborationAgentIdentity } from "@cocalc/util/collaboration-agent-identity";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { LiteCollaborators } from "./index";

const project_id = "11111111-1111-4111-8111-111111111111";
const agent_id = "22222222-2222-4222-8222-222222222222";
const account_id = "local-human";
const chat_path = "/home/user/agent.chat";
const native = (thread_id: string, activity = 3): CollaborationResource => ({
  project_id,
  chat_path,
  kind: "agent",
  resource_id: `agent-thread:${thread_id}`,
  thread_id,
  activity,
  title: thread_id,
  created_at: 1,
  updated_at: 2,
  participant_ids: [],
});

test.each([false, true])(
  "Lite keeps canonical agent/aliases and old refs across successors and restart (%s)",
  async (reverse) => {
    const directory = mkdtempSync(join(tmpdir(), "collaboration-agent-"));
    let identities: CollaborationAgentIdentity[] = [];
    let pins: string[] = [];
    const options = {
      filename: join(directory, "index.sqlite"),
      account_id,
      project_id,
      isEnabled: () => true,
      agentIdentities: () => identities,
      agentPins: {
        read: () => pins,
        set: (id: string, collected: boolean) => {
          pins = pins.filter((value) => value !== id);
          if (collected) pins.push(id);
        },
      },
    };
    let store = new LiteCollaborators(options);
    try {
      const { epoch } = await store.registerSource({
        project_id,
        chat_path,
        expected_epoch: null,
        registration_id: "writer",
      });
      let sequence = 0;
      const ingest = (resources: CollaborationResource[]) =>
        store.ingest({
          snapshot: {
            project_id,
            chat_path,
            epoch,
            sequence: ++sequence,
            resources,
          },
        });
      const old = native("old");
      await ingest([old]);
      await store.api.setPersonalState({
        ...old,
        account_id,
        patch: {
          alias: "my-label",
          collected: true,
          following: true,
          muted: true,
        },
      });
      identities = [
        { agent_id, project_id, path: chat_path, thread_id: "old" },
      ];
      await ingest([old]);
      expect(pins).toEqual([]);
      identities = [
        {
          ...identities[0],
          thread_id: "new",
          conversation_history: [{ thread_id: "old" }],
        },
      ];
      expect(await store.api.getResource({ ...old, account_id })).toMatchObject(
        { thread_id: "new", resource_id: old.resource_id },
      );
      const next = native("new", 1);
      const order = reverse ? [[next], [old]] : [[old], [next]];
      for (const rows of [...order, reverse ? [next, old] : [old, next]]) {
        await ingest(rows);
        const page = await store.api.listResources({
          account_id,
          kind: "agent",
        });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({
          resource_id: agent_id,
          thread_id: "new",
          personal: {
            alias: "my-label",
            collected: true,
            following: true,
            muted: true,
          },
        });
      }
      expect(pins).toEqual([]);
      const checkpoint = await store.checkpointPage({ project_id, chat_path });
      expect(checkpoint.items).toContainEqual({
        kind: "agent",
        resource_id: next.resource_id,
        activity: 1,
      });
      expect(checkpoint.items.some((r) => r.resource_id === agent_id)).toBe(
        false,
      );
      await ingest([{ ...next, activity: 2 }]);
      expect(
        await store.api.getResource({ ...next, account_id }),
      ).toMatchObject({ activity: 5 });
      store.close();
      store = new LiteCollaborators(options);
      for (const target of [old, next, { ...next, resource_id: agent_id }])
        expect(
          await store.api.getResource({ ...target, account_id }),
        ).toMatchObject({
          resource_id: target.resource_id,
          thread_id: "new",
          agent_id,
          personal: { alias: "my-label" },
        });
      await store.api.setPersonalState({
        ...old,
        account_id,
        patch: {
          alias: "renamed",
          following: false,
          muted: false,
          collected: false,
        },
      });
      await ingest([old, next]);
      expect(
        await store.api.getResource({ ...next, account_id }),
      ).toMatchObject({
        personal: {
          alias: "renamed",
          following: false,
          muted: false,
          collected: false,
        },
      });
      const copy = { ...old, resource_id: "copy:isolated", agent_id };
      await ingest([old, next, copy]);
      const copied = await store.api.getResource({ ...copy, account_id });
      expect(copied?.agent_id).toBeUndefined();
      expect(copied?.personal).toMatchObject({
        collected: false,
        following: false,
        muted: false,
      });
      expect(copied?.personal?.alias).toBeUndefined();
      await ingest([{ ...next, archived: true }, copy]);
      await ingest([old, copy]);
      expect(await store.api.getResource({ ...old, account_id })).toMatchObject(
        { thread_id: "new", archived: true },
      );
      expect(
        (
          await store.api.listResources({ account_id, kind: "agent" })
        ).items.map((r) => r.resource_id),
      ).toEqual([copy.resource_id]);
      identities = [];
      expect(await store.api.getResource({ ...old, account_id })).toBeNull();
      await ingest([old, next, copy]);
      expect(await store.api.getResource({ ...old, account_id })).toBeNull();
      expect(
        (await store.api.listResources({ account_id })).items.map(
          (r) => r.resource_id,
        ),
      ).toEqual([copy.resource_id]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("local source metadata cannot enroll an unnamed agent through an asserted identity", async () => {
  const store = new LiteCollaborators({
    filename: ":memory:",
    account_id,
    project_id,
    isEnabled: () => true,
  });
  try {
    const { epoch } = await store.registerSource({
      project_id,
      chat_path,
      expected_epoch: null,
      registration_id: "writer",
    });
    const resource = { ...native("unnamed"), agent_id };
    await store.ingest({
      snapshot: {
        project_id,
        chat_path,
        epoch,
        sequence: 1,
        resources: [resource],
      },
    });
    const result = await store.api.getResource({ ...resource, account_id });
    expect(result?.resource_id).toBe(resource.resource_id);
    expect(result?.agent_id).toBeUndefined();
  } finally {
    store.close();
  }
});
