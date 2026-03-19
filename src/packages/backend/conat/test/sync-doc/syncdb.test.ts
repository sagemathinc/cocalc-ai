import {
  before,
  after,
  uuid,
  delay,
  wait,
  connect,
  server,
  once,
} from "./setup";

beforeAll(before);
afterAll(after);

describe("loading/saving syncstring to disk and setting values", () => {
  let s;
  const project_id = uuid();
  let client;

  it("creates a client", () => {
    client = connect();
  });

  it("a syncdb associated to a file that does not exist on disk is initialized to empty", async () => {
    s = client.sync.db({
      project_id,
      path: "new.syncdb",
      service: server.service,
      primary_keys: ["name"],
      firstReadLockTimeout: 1,
    });
    await once(s, "ready");
    expect(s.to_str()).toBe("");
    // there's one version loading the empty string from disk.
    expect(s.versions().length).toBe(1);
  });

  it("store a record", async () => {
    s.set({ name: "cocalc", value: 10 });
    expect(s.to_str()).toBe('{"name":"cocalc","value":10}');
    const t = s.get_one({ name: "cocalc" }).toJS();
    expect(t).toEqual({ name: "cocalc", value: 10 });
    await s.commit();
    await s.save();
    // [ ] TODO: this save to disk definitely should NOT be needed
    await s.save_to_disk();
  });

  let client2, s2;
  it("connect another client", async () => {
    client2 = connect();
    // [ ] loading this resets the state if we do not save above.
    s2 = client2.sync.db({
      project_id,
      path: "new.syncdb",
      service: server.service,
      primary_keys: ["name"],
      firstReadLockTimeout: 1,
    });
    await once(s2, "ready");
    expect(s2).not.toBe(s);
    expect(s2.to_str()).toBe('{"name":"cocalc","value":10}');
    const t = s2.get_one({ name: "cocalc" }).toJS();
    expect(t).toEqual({ name: "cocalc", value: 10 });

    s2.set({ name: "conat", date: new Date() });
    s2.commit();
    await s2.save();
  });

  it("verifies the change on s2 is seen by s (and also that Date objects do NOT work)", async () => {
    await wait({ until: () => s.get_one({ name: "conat" }) != null });
    const t = s.get_one({ name: "conat" }).toJS();
    expect(t).toEqual({ name: "conat", date: t.date });
    // They don't work because we're storing syncdb's in jsonl format,
    // so json is used.  We should have a new format called
    // msgpackl and start using that.
    expect(t.date instanceof Date).toBe(false);
  });

  const count = 1000;
  it(`store ${count} records`, async () => {
    const before = s.get().size;
    for (let i = 0; i < count; i++) {
      s.set({ name: i });
    }
    s.commit();
    await s.save();
    expect(s.get().size).toBe(count + before);
  });

  it("confirm file saves to disk with many lines", async () => {
    await s.save_to_disk();
    await delay(50); // wait for lock to go away
    const v = (await s.fs.readFile("new.syncdb", "utf8")).split("\n");
    expect(v.length).toBe(s.get().size);
  });

  it("verifies lookups are not too slow (there is an index)", () => {
    for (let i = 0; i < count; i++) {
      expect(s.get_one({ name: i }).get("name")).toEqual(i);
    }
  });
});

describe("chat-style syncdb without backend fs watch still loads existing disk state", () => {
  const project_id = uuid();
  let client;
  let fs0;
  let s;
  const chatDate = "2026-03-10T10:00:00.000Z";
  const chatFileContents =
    '{"event":"chat","sender_id":"user-1","date":"2026-03-10T10:00:00.000Z","message_id":"msg-1","thread_id":"thread-1","history":[{"author_id":"user-1","content":"hello from cloned chat","date":"2026-03-10T10:00:00.000Z"}]}\n' +
    '{"event":"chat-thread-config","sender_id":"__thread_config__","date":"1970-01-01T00:00:00.000Z","thread_id":"thread-1","name":"Forked thread"}\n';

  it("creates the client and a pre-existing chat file", async () => {
    client = connect();
    fs0 = client.fs({ project_id, service: server.service });
    await fs0.writeFile("existing.chat", chatFileContents);
  });

  it("loads the chat file from disk even though backend watch is disabled", async () => {
    s = client.sync.db({
      project_id,
      path: "existing.chat",
      service: server.service,
      primary_keys: ["date", "sender_id", "event", "message_id", "thread_id"],
      string_cols: ["input"],
      firstReadLockTimeout: 1,
    });
    await once(s, "ready");
    expect(
      s.get_one({ event: "chat", sender_id: "user-1", date: chatDate }),
    ).toBeTruthy();
    expect(
      s
        .get_one({ event: "chat", sender_id: "user-1", date: chatDate })
        .get("message_id"),
    ).toBe("msg-1");
    expect(
      s
        .get_one({
          event: "chat-thread-config",
          sender_id: "__thread_config__",
          date: "1970-01-01T00:00:00.000Z",
          thread_id: "thread-1",
        })
        .get("name"),
    ).toBe("Forked thread");
  });

  it("does not blank the chat file when saving it back to disk", async () => {
    await s.save_to_disk();
    await delay(50);
    const disk = await fs0.readFile("existing.chat", "utf8");
    expect(disk.length).toBeGreaterThan(0);
    expect(disk).toContain('"message_id":"msg-1"');
  });
});

describe("chat-style syncdb preserves prior live rows when a second client opens", () => {
  const project_id = uuid();
  const path = "live.chat";
  const primary_keys = [
    "date",
    "sender_id",
    "event",
    "message_id",
    "thread_id",
  ];
  const string_cols = ["input"];
  const thread_id = "thread-live-1";
  const userDate = "2026-03-19T12:00:00.000Z";
  const assistantDate = "2026-03-19T12:00:01.000Z";
  let client1;
  let client2;
  let s1;
  let s2;

  it("opens the first chat client", async () => {
    client1 = connect();
    s1 = client1.sync.db({
      project_id,
      path,
      service: server.service,
      primary_keys,
      string_cols,
      firstReadLockTimeout: 1,
    });
    await once(s1, "ready");
  });

  it("writes a user chat row without saving to disk", async () => {
    s1.set({
      event: "chat",
      sender_id: "user-1",
      date: userDate,
      message_id: "msg-user-1",
      thread_id,
      history: [
        {
          author_id: "user-1",
          content: "hello from client 1",
          date: userDate,
        },
      ],
    });
    s1.commit();
    await s1.save();
    expect(
      s1.get_one({
        event: "chat",
        sender_id: "user-1",
        date: userDate,
      }),
    ).toBeTruthy();
  });

  it("opens a second client and still sees the user row", async () => {
    client2 = connect();
    s2 = client2.sync.db({
      project_id,
      path,
      service: server.service,
      primary_keys,
      string_cols,
      firstReadLockTimeout: 1,
    });
    await once(s2, "ready");
    expect(
      s2.get_one({
        event: "chat",
        sender_id: "user-1",
        date: userDate,
      }),
    ).toBeTruthy();
  });

  it("writes an assistant row from client 2 without deleting the user row", async () => {
    s2.set({
      event: "chat",
      sender_id: "assistant-1",
      date: assistantDate,
      message_id: "msg-assistant-1",
      thread_id,
      parent_message_id: "msg-user-1",
      history: [
        {
          author_id: "assistant-1",
          content: "reply from client 2",
          date: assistantDate,
        },
      ],
    });
    s2.commit();
    await s2.save();

    await wait({
      until: () =>
        s1.get_one({
          event: "chat",
          sender_id: "assistant-1",
          date: assistantDate,
        }) != null,
    });

    expect(
      s1.get_one({
        event: "chat",
        sender_id: "user-1",
        date: userDate,
      }),
    ).toBeTruthy();
    expect(
      s1.get_one({
        event: "chat",
        sender_id: "assistant-1",
        date: assistantDate,
      }),
    ).toBeTruthy();
  });
});
