import { flushExistingCanonicalRoom } from "./flush";

const room = {
  project_id: "11111111-1111-4111-8111-111111111111",
  room_id: "22222222-2222-4222-8222-222222222222",
  chat_path: "/home/user/.cocalc/collaborators.chat",
  initialized: true,
};
const marker = {
  event: "collaborators-room",
  project_id: room.project_id,
  room_id: room.room_id,
  mode: "human",
  schema_version: 1,
};
function setup() {
  let disk: unknown[] = [marker];
  let live: unknown[] = [
    marker,
    { event: "chat", message_id: "durable-browser-message" },
  ];
  const db = {
    get: () => live,
    save: jest.fn(async () => {}),
    save_to_disk: jest.fn(async () => {
      disk = [...live];
    }),
  };
  const save = db.save;
  const options = {
    room,
    assertCurrent: jest.fn(async () => {}),
    read: jest.fn(async () => disk),
    acquire: jest.fn(async () => db),
    release: jest.fn(async () => {}),
  };
  return {
    options,
    db,
    save,
    setDisk: (rows: unknown[]) => {
      disk = rows;
    },
    setLive: (rows: unknown[]) => {
      live = rows;
    },
  };
}
test("flushes acknowledged live history through normal APIs and skips unchanged snapshots", async () => {
  const { options, db, save } = setup();
  expect(await flushExistingCanonicalRoom(options)).toBe(true);
  expect(save).toHaveBeenCalledTimes(1);
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
  expect(await flushExistingCanonicalRoom(options)).toBe(false);
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
  expect(options.release).toHaveBeenCalledTimes(2);
});
test("failed authority/feature gate and uninitialized rooms do not open a document", async () => {
  const { options } = setup();
  await expect(
    flushExistingCanonicalRoom({
      ...options,
      room: { ...room, initialized: false },
    }),
  ).rejects.toThrow(/not initialized/);
  options.assertCurrent.mockRejectedValueOnce(Error("disabled or fenced"));
  await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(/fenced/);
  expect(options.read).not.toHaveBeenCalled();
  expect(options.acquire).not.toHaveBeenCalled();
});
test.each([
  { rows: [] },
  { rows: [marker, marker] },
  { rows: [{ ...marker, room_id: "replacement" }] },
  {
    rows: [
      marker,
      { event: "collaborators-identity", identity_namespace: "copy" },
    ],
  },
])(
  "rejects absent, replaced and copied disk markers before acquisition: %j",
  async ({ rows }) => {
    const { options, setDisk } = setup();
    setDisk(rows);
    await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(
      /room|copied/,
    );
    expect(options.acquire).not.toHaveBeenCalled();
  },
);
test("deletion while opening or checking authority cannot recreate a room", async () => {
  for (const during of ["acquire", "authority"] as const) {
    const { options, db, setDisk } = setup();
    if (during === "acquire")
      options.acquire.mockImplementationOnce(async () => {
        setDisk([]);
        return db;
      });
    else
      options.assertCurrent.mockImplementation(async () => {
        if (options.assertCurrent.mock.calls.length === 3) setDisk([]);
      });
    await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(
      /deleted/,
    );
    expect(db.save_to_disk).not.toHaveBeenCalled();
    expect(options.release).toHaveBeenCalledTimes(1);
  }
});
test("wrong live marker and oversized live rows fail before any disk write", async () => {
  const { options, db, setLive } = setup();
  for (const rows of [
    [],
    [marker, { event: "collaborators-identity" }],
    [marker, { value: "x".repeat(16 * 1024 * 1024) }],
    Array(100_001).fill(marker),
  ]) {
    setLive(rows);
    await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(
      /room|copied/,
    );
  }
  expect(db.save_to_disk).not.toHaveBeenCalled();
  expect(options.release).toHaveBeenCalledTimes(4);
});
test("lost disk ACK closes its session and a fresh retry recognizes the persisted snapshot", async () => {
  const { options, db, setDisk } = setup();
  db.save_to_disk.mockImplementationOnce(async () => {
    setDisk([...db.get()]);
    throw Error("disk ACK lost");
  });
  await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(/ACK lost/);
  expect(options.release).toHaveBeenCalledTimes(1);
  expect(await flushExistingCanonicalRoom(options)).toBe(false);
  expect(db.save_to_disk).toHaveBeenCalledTimes(1);
});
test("a successful-looking no-op save is not a successful flush", async () => {
  const { options, db } = setup();
  db.save_to_disk.mockImplementationOnce(async () => {});
  await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(
    /not persisted/,
  );
  expect(options.release).toHaveBeenCalledTimes(1);
  expect(await flushExistingCanonicalRoom(options)).toBe(true);
});
test("a concurrently changed disk snapshot conservatively retries", async () => {
  const { options, db, setDisk } = setup();
  db.save_to_disk.mockImplementationOnce(async () => {
    setDisk([...db.get(), { event: "chat", message_id: "concurrent" }]);
  });
  await expect(flushExistingCanonicalRoom(options)).rejects.toThrow(
    /not persisted/,
  );
  expect(options.release).toHaveBeenCalledTimes(1);
});
test.each(["save", "save_to_disk"])(
  "network timeout in %s cannot continue into a late filesystem write",
  async (phase) => {
    jest.useFakeTimers();
    try {
      const { options, db, save } = setup();
      let acknowledge!: () => void;
      const stuck = () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
      if (phase === "save") save.mockImplementationOnce(stuck);
      else save.mockResolvedValueOnce(undefined).mockImplementationOnce(stuck);
      const write = jest.fn();
      // Match SyncDoc's actual boundary: save_to_disk awaits this.save before FS.
      db.save_to_disk.mockImplementationOnce(async () => {
        await db.save();
        write();
      });
      const result = flushExistingCanonicalRoom({
        ...options,
        saveTimeoutMs: 100,
      });
      const failed = expect(result).rejects.toThrow(/save timed out/);
      await jest.advanceTimersByTimeAsync(100);
      await failed;
      expect(options.release).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      acknowledge();
      await Promise.resolve();
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  },
);
test("a started filesystem write retains its fence until completion, not a timeout race", async () => {
  jest.useFakeTimers();
  try {
    const { options, db, setDisk } = setup();
    let finish!: () => void;
    db.save_to_disk.mockImplementationOnce(async () => {
      await db.save();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      setDisk([...db.get()]);
    });
    const result = flushExistingCanonicalRoom({
      ...options,
      saveTimeoutMs: 100,
    });
    await jest.advanceTimersByTimeAsync(1000);
    expect(options.release).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe(true);
    expect(options.release).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
