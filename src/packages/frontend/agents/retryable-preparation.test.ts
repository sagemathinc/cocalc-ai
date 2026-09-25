import {
  retryablePreparation,
  readPreparedFirstAgent,
  writePreparedFirstAgent,
} from "./retryable-preparation";

it("shares background preparation with immediate and repeated submission", async () => {
  const prepare = retryablePreparation<string>();
  let resolve!: (value: string) => void;
  const work = jest.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const background = prepare(work);
  const submit = prepare(work);
  expect(submit).toBe(background);
  await Promise.resolve();
  resolve("same-agent");
  expect(await submit).toBe("same-agent");
  expect(await prepare(work)).toBe("same-agent");
  expect(work).toHaveBeenCalledTimes(1);
});

it("retries a failed later stage without recreating the successful chat", async () => {
  const chat = retryablePreparation<string>();
  const identity = retryablePreparation<string>();
  const all = retryablePreparation<string>();
  const makeChat = jest.fn(async () => "chat");
  const nameAgent = jest
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue("agent");
  const work = async () => {
    await chat(makeChat);
    return identity(nameAgent);
  };
  await expect(all(work)).rejects.toThrow("offline");
  expect(await all(work)).toBe("agent");
  expect(makeChat).toHaveBeenCalledTimes(1);
  expect(nameAgent).toHaveBeenCalledTimes(2);
});

it("checkpoints a saved first agent across remounts without crossing accounts", () => {
  sessionStorage.clear();
  const value = {
    projectId: "project",
    path: "/home/user/agent.chat",
    threadId: "thread",
    name: "agent",
    automaticProjectTitle: "My first project",
  };
  writePreparedFirstAgent("alice", value);
  expect(readPreparedFirstAgent("alice")).toEqual(value);
  expect(readPreparedFirstAgent("bob")).toBeUndefined();
  writePreparedFirstAgent("alice");
  expect(readPreparedFirstAgent("alice")).toBeUndefined();
});
