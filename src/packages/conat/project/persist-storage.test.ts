import {
  MAX_PERSIST_STORAGE_ACTIONS,
  applyPersistStorageInChunks,
  type PersistStorageAction,
} from "./persist-storage";

describe("applyPersistStorageInChunks", () => {
  it("sends at most the limit per request, and adds up the results", async () => {
    const actions: PersistStorageAction[] = Array.from(
      { length: 2 * MAX_PERSIST_STORAGE_ACTIONS + 1 },
      (_, i) => ({ op: "delete", name: `s${i}` }),
    );
    const sizes: number[] = [];
    const result = await applyPersistStorageInChunks(actions, async (chunk) => {
      sizes.push(chunk.length);
      return {
        results: chunk.map(({ name, op }) => ({
          name,
          op,
          ok: true,
          freed: 2,
        })),
        freed: 2 * chunk.length,
      };
    });
    expect(sizes).toEqual([
      MAX_PERSIST_STORAGE_ACTIONS,
      MAX_PERSIST_STORAGE_ACTIONS,
      1,
    ]);
    expect(result.results.map((r) => r.name)).toEqual(
      actions.map((a) => a.name),
    );
    expect(result.freed).toBe(2 * actions.length);
    expect(
      await applyPersistStorageInChunks([], async () => {
        throw new Error("never");
      }),
    ).toEqual({ results: [], freed: 0 });
  });
});
