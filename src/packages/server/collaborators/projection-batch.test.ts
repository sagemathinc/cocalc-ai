import { createSharedProjectionFetcher } from "./projection-batch";
import type {
  CollaborationProjectionRequest,
  CollaborationSharedProjectionPage,
} from "@cocalc/conat/inter-bay/collaborators";
const job = (account_id: string): CollaborationProjectionRequest => ({
  account_id,
  project_id: "project",
  generation: null,
  revision: 0,
  after_key: "",
});
test("compatible recipients share one fetch but retain independent attention and pages", async () => {
  const jobs = [job("a"), job("b"), job("denied")];
  const response: CollaborationSharedProjectionPage = {
    catalog: {
      generation: "gen",
      reset: true,
      complete: true,
      revision: 1,
      after_key: "",
      items: [
        {
          entry_key: "key",
          revision: 1,
          resource: { resource_id: "r", title: "original" } as any,
        },
      ],
    },
    recipients: [
      {
        account_id: "a",
        allowed: true,
        attention_generation: "a-gen",
        floors: { r: 2 },
      },
      {
        account_id: "b",
        allowed: true,
        attention_generation: "b-gen",
        floors: { r: 7 },
      },
      { account_id: "denied", allowed: false },
    ],
  };
  const fetch = jest.fn().mockResolvedValue(response);
  const run = createSharedProjectionFetcher(jobs, fetch);
  const [a, b, denied] = await Promise.all(jobs.map(run));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0].account_ids).toEqual(["a", "b", "denied"]);
  expect(denied).toEqual({ allowed: false });
  if (!a.allowed || !b.allowed) throw Error("expected authorized pages");
  expect(a.attention_generation).toBe("a-gen");
  expect(b.attention_generation).toBe("b-gen");
  expect(a.items[0].initial_activity).toBe(2);
  expect(b.items[0].initial_activity).toBe(7);
  a.items[0].resource!.title = "changed";
  expect(b.items[0].resource!.title).toBe("original");
});
test("incompatible cursors never share an owner page", async () => {
  const jobs = [
    job("a"),
    { ...job("b"), revision: 1 },
    { ...job("c"), project_id: "other" },
  ];
  const fetch = jest
    .fn()
    .mockImplementation(async (r) => ({
      catalog: null,
      recipients: r.account_ids.map((account_id) => ({
        account_id,
        allowed: false,
      })),
    }));
  await Promise.all(jobs.map(createSharedProjectionFetcher(jobs, fetch)));
  expect(fetch).toHaveBeenCalledTimes(3);
});
test("unknown outcomes are shared without retrying and malformed overlays do not become denial", async () => {
  const jobs = [job("a"), job("b")];
  const fetch = jest.fn().mockRejectedValue(Error("timeout"));
  const results = await Promise.allSettled(
    jobs.map(createSharedProjectionFetcher(jobs, fetch)),
  );
  expect(results.every((r) => r.status === "rejected")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  const malformed = createSharedProjectionFetcher(jobs, async () => ({
    catalog: null,
    recipients: [],
  }));
  await expect(malformed(jobs[0])).rejects.toThrow("recipient");
  await expect(malformed(job("outside"))).rejects.toThrow("outside");
  expect(() =>
    createSharedProjectionFetcher(Array(17).fill(job("a")), fetch),
  ).toThrow("limit");
});
