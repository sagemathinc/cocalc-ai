describe("createSharedLroListClient", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("dedupes concurrent requests and caches recent results", async () => {
    const value = [{ op_id: "op-1" }];
    const listLro = jest.fn(async () => value);
    const { createSharedLroListClient } = require("./shared-list");
    const shared = createSharedLroListClient({
      listLro,
      ttlMs: 5_000,
    });

    const opts = { scope_type: "project", scope_id: "p1" };
    const [a, b] = await Promise.all([shared(opts), shared(opts)]);
    expect(a).toBe(value);
    expect(b).toBe(value);
    expect(listLro).toHaveBeenCalledTimes(1);

    const c = await shared(opts);
    expect(c).toBe(value);
    expect(listLro).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 5_001);
    const d = await shared(opts);
    expect(d).toBe(value);
    expect(listLro).toHaveBeenCalledTimes(2);
  });
});
