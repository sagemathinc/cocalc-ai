import { createServiceClient } from "./typed";

describe("typed service client", () => {
  it("is not treated as a thenable when returned from async code", async () => {
    const client = createServiceClient<any>({
      service: "test",
      subject: "test.subject",
      client: {} as any,
    });

    expect((client as any).then).toBeUndefined();

    const wrapped = async () => client;

    await expect(wrapped()).resolves.toBe(client);
  });
});
