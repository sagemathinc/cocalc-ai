import { LitePersonalLibrary } from "./personal-library";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account_id = "11111111-1111-4111-8111-111111111111";
const project_id = "22222222-2222-4222-8222-222222222222";
const entryA = "a".repeat(64);
const entryB = "b".repeat(64);
const pinA = JSON.stringify([project_id, "/chat.chat", "thread", "artifact-a"]);
const pinB = JSON.stringify([project_id, "/chat.chat", "thread", "artifact-b"]);
const pinEntry = (pin: string) =>
  createHash("sha256").update(pin).digest("hex");

function open() {
  return new LitePersonalLibrary({
    filename: ":memory:",
    account_id,
    project_id,
    artifactExists: async (_, entryId) =>
      [entryA, entryB, pinEntry(pinA), pinEntry(pinB)].includes(entryId),
  });
}

test("names are unique per account and previous names remain redirects", async () => {
  const library = open();
  try {
    await library.name({
      account_id,
      project_id,
      entry_id: entryA,
      name: "nb1",
    });
    await library.name({
      account_id,
      project_id,
      entry_id: entryA,
      name: "primes",
    });
    expect(await library.resolve({ account_id, name: "nb1" })).toMatchObject({
      entry_id: entryA,
      active: false,
    });
    expect(await library.resolve({ account_id, name: "primes" })).toMatchObject(
      {
        entry_id: entryA,
        active: true,
      },
    );
    await expect(
      library.name({ account_id, project_id, entry_id: entryB, name: "nb1" }),
    ).rejects.toThrow(/already used/);
    await expect(
      library.name({
        account_id,
        project_id,
        entry_id: entryB,
        name: "missing",
      }),
    ).resolves.toMatchObject({ aliases: expect.any(Array) });
    await expect(
      library.name({
        account_id,
        project_id,
        entry_id: entryB,
        name: "primes",
      }),
    ).rejects.toThrow(/already used/);
  } finally {
    library.close();
  }
});

test("pins require a known artifact and preserve ordering", async () => {
  const library = open();
  try {
    await expect(
      library.setPinned({
        account_id,
        pin_key: JSON.stringify([
          project_id,
          "/chat.chat",
          "thread",
          "missing",
        ]),
        pinned: true,
      }),
    ).rejects.toThrow("Artifact unavailable");
    await library.setPinned({ account_id, pin_key: pinA, pinned: true });
    await library.setPinned({ account_id, pin_key: pinB, pinned: true });
    expect((await library.list({ account_id })).pins).toEqual([pinA, pinB]);
    await library.setPinned({ account_id, pin_key: pinA, pinned: true });
    expect((await library.list({ account_id })).pins).toEqual([pinA, pinB]);
    await library.movePinned({
      account_id,
      visible: [pinA, pinB],
      pin_key: pinB,
      index: 0,
    });
    expect((await library.list({ account_id })).pins).toEqual([pinB, pinA]);
    await library.setPinned({ account_id, pin_key: pinA, pinned: false });
    expect((await library.list({ account_id })).pins).toEqual([pinB]);
  } finally {
    library.close();
  }
});

test("personal names persist across Lite process restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lite-personal-library-"));
  const options = {
    filename: join(directory, "library.sqlite"),
    account_id,
    project_id,
    artifactExists: async () => true,
  };
  try {
    const first = new LitePersonalLibrary(options);
    await first.name({ account_id, project_id, entry_id: entryA, name: "nb1" });
    first.close();
    const reopened = new LitePersonalLibrary(options);
    try {
      expect(await reopened.resolve({ account_id, name: "nb1" })).toMatchObject(
        {
          entry_id: entryA,
        },
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
