import { PubSub } from "./pubsub";

describe("PubSub explicit client routing", () => {
  it("requires an explicit client", () => {
    expect(
      () => new PubSub({ project_id: "project-1", name: "cursor" } as any),
    ).toThrow("pubsub must provide an explicit Conat client");
  });
});
