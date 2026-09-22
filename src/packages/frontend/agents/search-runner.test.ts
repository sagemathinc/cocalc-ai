import { runAgentSearch, boundedProjectSearch } from "./search-runner";
import type { NamedAgent } from "@cocalc/conat/agents/personal";

const agents = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      ({
        name: `agent-${i}`,
        endpoint: { project_id: `project-${i % 4}`, agent_id: `${i}` },
        thread_id: `thread-${i}`,
      }) as NamedAgent,
  );
const hit = (date_ms: number) => ({
  row_id: date_ms,
  segment_id: "head",
  date_ms,
});
const defaults = () => ({
  query: "test",
  includePast: false,
  available: () => true,
  history: jest.fn(async () => [] as string[]),
  report: jest.fn(),
  canceled: () => false,
});

test("1000 agents: expands empty batches only to the hard cap, with bounded project concurrency", async () => {
  let concurrent = 0,
    peak = 0;
  const projects = new Set<string>();
  const search = jest.fn(async (agent: NamedAgent) => {
    expect(projects.has(agent.endpoint.project_id)).toBe(false);
    projects.add(agent.endpoint.project_id);
    peak = Math.max(peak, ++concurrent);
    await new Promise((resolve) => setTimeout(resolve, 1));
    concurrent--;
    projects.delete(agent.endpoint.project_id);
    return [];
  });
  const result = await runAgentSearch({
    ...defaults(),
    agents: agents(1000),
    search,
  });
  expect(search).toHaveBeenCalledTimes(100);
  expect(peak).toBe(1);
  expect(result).toMatchObject({
    searched: 100,
    remaining: 900,
    limited: true,
  });
});

test("stops after first batch with enough hits; sorts newest first", async () => {
  const search = jest.fn(async () => [hit(1), hit(100)]);
  const result = await runAgentSearch({
    ...defaults(),
    agents: agents(1000),
    search,
  });
  expect(search).toHaveBeenCalledTimes(20);
  expect(result.hits[0].hit.date_ms).toBe(100);
  expect(result.hits.at(-1)?.hit.date_ms).toBe(1);
});

test("unavailable projects are not contacted and history is opt-in", async () => {
  const options = defaults();
  const search = jest.fn(async () => [hit(1)]);
  const result = await runAgentSearch({
    ...options,
    agents: agents(4),
    search,
    available: (a) => a.name !== "agent-0",
  });
  expect(search).toHaveBeenCalledTimes(3);
  expect(options.history).not.toHaveBeenCalled();
  expect(result).toMatchObject({ searched: 3, unavailable: 1, remaining: 0 });
});

test("past threads and total thread requests are bounded", async () => {
  const history = jest.fn(async () =>
    Array.from({ length: 50 }, (_, i) => `past-${i}`),
  );
  const search = jest.fn(async () => []);
  const result = await runAgentSearch({
    ...defaults(),
    agents: agents(1000),
    search,
    includePast: true,
    history,
  });
  expect(search.mock.calls.length).toBeLessThanOrEqual(150);
  expect(result.limited).toBe(true);
});

test("deadline and cancellation stop scheduling", async () => {
  let time = 0;
  const search = jest.fn(async () => {
    time += 100;
    return [];
  });
  const result = await runAgentSearch({
    ...defaults(),
    agents: agents(1000),
    search,
    now: () => time,
    budgetMs: 50,
  });
  expect(search).toHaveBeenCalledTimes(1);
  expect(result.remaining).toBeGreaterThan(990);
  search.mockClear();
  await runAgentSearch({
    ...defaults(),
    agents: agents(10),
    search,
    canceled: () => true,
  });
  expect(search).not.toHaveBeenCalled();
});

test("capacity remains occupied until an outstanding request settles", async () => {
  let done!: () => void;
  const pending = boundedProjectSearch(
    "hung-project",
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  await expect(
    boundedProjectSearch("hung-project", async () => undefined),
  ).rejects.toThrow("still finishing");
  await expect(
    boundedProjectSearch("another-project", async () => undefined),
  ).rejects.toThrow("still finishing");
  done();
  await pending;
  await expect(
    boundedProjectSearch("hung-project", async () => "ok"),
  ).resolves.toBe("ok");
});

test("continuation reaches less active agents without re-searching earlier scopes", async () => {
  const all = agents(120);
  const search = jest.fn(async () => []);
  const first = await runAgentSearch({ ...defaults(), agents: all, search });
  const remaining = all.filter(
    (a) => !first.attempted?.includes(a.endpoint.agent_id),
  );
  const next = await runAgentSearch({
    ...defaults(),
    agents: remaining,
    search,
  });
  expect(first.attempted).toHaveLength(100);
  expect(next.searched).toBe(20);
  expect(next.remaining).toBe(0);
  expect(search).toHaveBeenCalledTimes(120);
});
