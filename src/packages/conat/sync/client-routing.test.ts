import { cstream } from "./core-stream";
import { dstream } from "./dstream";
import { dkv } from "./dkv";
import { dko, userKvKey } from "./dko";
import { akv } from "./akv";
import { astream } from "./astream";
import { inventory } from "./inventory";

describe("sync explicit client routing", () => {
  it("requires explicit clients for shared sync helpers", async () => {
    await expect(cstream({ name: "core" } as any)).rejects.toThrow(
      "cstream: client must be specified",
    );
    await expect(dstream({ name: "stream" } as any)).rejects.toThrow(
      "dstream: client must be specified",
    );
    await expect(dkv({ name: "kv" } as any)).rejects.toThrow(
      "dkv: client must be specified",
    );
    await expect(dko({ name: "obj" } as any)).rejects.toThrow(
      "dko: client must be specified",
    );
    await expect(inventory({ project_id: "p" } as any)).rejects.toThrow(
      "inventory: client must be specified",
    );
    expect(() => akv({ name: "async-kv" } as any)).toThrow(
      "akv: client must be specified",
    );
    expect(() => astream({ name: "async-stream" } as any)).toThrow(
      "astream: client must be specified",
    );
  });

  it("includes client identity in dko cache keys", () => {
    expect(userKvKey({ name: "same", client: { id: "a" } as any })).not.toBe(
      userKvKey({ name: "same", client: { id: "b" } as any }),
    );
  });
});
