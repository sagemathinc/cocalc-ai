/*
An editor saves its whole value. If a remote change has reached the document
but not the editor yet (e.g. deferred while its user types), diffing the
editor's value against the latest document would delete that change. Saving
with the value the editor was showing as the base applies only the editor's
own changes. Found by the multi-user browser test of a Markdown file.
*/

import {
  before,
  after,
  uuid,
  connect,
  server,
  once,
  waitUntilSynced,
} from "./setup";

beforeAll(before);
afterAll(after);

describe("saving an editor's value with its base", () => {
  const project_id = uuid();
  const docs: any[] = [];
  const open = async (path: string) => {
    const doc = connect().sync.string({
      project_id,
      path,
      service: server.service,
      noAutosave: true,
      noBackendFsWatch: true,
      firstReadLockTimeout: 1,
    });
    docs.push(doc);
    await once(doc, "ready");
    return doc;
  };
  afterAll(async () => {
    for (const doc of docs) {
      try {
        await doc.close();
      } catch {}
    }
  });

  it("keeps a remote change the editor has not shown", async () => {
    const s1 = await open("save-with-base.txt");
    const s2 = await open("save-with-base.txt");
    s1.from_str("a\nb\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    // What s2's editor shows, before the remote change below reaches it.
    const shown = s2.to_str();
    expect(shown).toBe("a\nb\n");

    s1.from_str("a\nb\nfrom s1\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    expect(s2.to_str()).toBe("a\nb\nfrom s1\n");

    // s2's user typed into the editor, which still shows `shown`.
    s2.from_str("a\nb\nzz\n", { base: shown });
    s2.commit();
    await s2.save();
    await waitUntilSynced([s1, s2]);
    for (const s of [s1, s2]) {
      expect(s.to_str()).toContain("from s1");
      expect(s.to_str()).toContain("zz");
    }
  }, 60_000);

  it("keeps it too when the change arrives between setting and committing", async () => {
    const s1 = await open("save-with-base-2.txt");
    const s2 = await open("save-with-base-2.txt");
    s1.from_str("one\ntwo\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);

    const shown = s2.to_str();
    // s2 sets its editor's value but has not committed when s1's change lands.
    s2.from_str("one\ntwo\nfrom s2\n", { base: shown });
    s1.from_str("zero\none\ntwo\n");
    s1.commit();
    await s1.save();
    await waitUntilSynced([s1, s2]);
    s2.commit();
    await s2.save();
    await waitUntilSynced([s1, s2]);
    for (const s of [s1, s2]) {
      expect(s.to_str()).toBe("zero\none\ntwo\nfrom s2\n");
    }
  }, 60_000);
});
