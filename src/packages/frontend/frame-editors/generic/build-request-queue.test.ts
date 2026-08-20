import { buildRequestJobKey } from "@cocalc/util/document-build";

import {
  BuildRequestQueue,
  buildStageIsPastKnitr,
  classifyBuildJob,
  isOwnPipelineStage,
  jobAggregateValue,
  selectBuildAggregate,
  untaggedBuildAggregate,
} from "./project-builds";

const makeQueue = (
  opts: {
    run?: () => Promise<void>;
    busy?: () => boolean;
  } = {},
) => {
  const replies: string[] = [];
  let runs = 0;
  const queue = new BuildRequestQueue(
    async () => {
      runs += 1;
      await opts.run?.();
    },
    async (id) => {
      replies.push(id);
    },
    opts.busy ?? (() => false),
    1, // poll fast in tests
    2_000,
  );
  return { queue, replies, runCount: () => runs };
};

describe("BuildRequestQueue", () => {
  it("runs a tagged request and replies to it", async () => {
    const { queue, replies, runCount } = makeQueue();
    await queue.handleJob("req-1", 1);
    expect(runCount()).toBe(1);
    expect(replies).toEqual(["req-1"]);
    expect(queue.isRunning()).toBe(false);
  });

  it("ignores untagged jobs instead of scheduling a rebuild", async () => {
    // A build started by this queue emits its own stage jobs into the same
    // watched group.  Queueing those would schedule another build, which would
    // emit more jobs -- an endless rebuild loop.
    const { queue, replies, runCount } = makeQueue();
    await queue.handleJob("", 1);
    await queue.handleJob("", 1);
    expect(runCount()).toBe(0);
    expect(replies).toEqual([]);
  });

  it("does not loop when the build itself emits jobs back into the queue", async () => {
    const seen: string[] = [];
    let queue!: BuildRequestQueue;
    const replies: string[] = [];
    let runs = 0;
    queue = new BuildRequestQueue(
      async () => {
        runs += 1;
        seen.push(`run-${runs}`);
        // the pipeline's own stages come back through the watcher untagged
        await queue.handleJob("", 1);
        await queue.handleJob("", 1);
      },
      async (id) => {
        replies.push(id);
      },
      () => false,
      1,
      2_000,
    );

    await queue.handleJob("req-1", 1);
    expect(runs).toBe(1);
    expect(replies).toEqual(["req-1"]);
    expect(queue.isRunning()).toBe(false);
  });

  it("coalesces requests that arrive before the build starts", async () => {
    let runs = 0;
    const replies: string[] = [];
    const queue = new BuildRequestQueue(
      async () => {
        runs += 1;
      },
      async (id) => {
        replies.push(id);
      },
      () => false,
      1,
      2_000,
    );

    const running = queue.handleJob("req-1", 1);
    await queue.handleJob("req-2", 1); // still before run() was invoked
    await running;

    // one build satisfies both, and both are answered
    expect(runs).toBe(1);
    expect(replies).toEqual(["req-1", "req-2"]);
  });

  it("rebuilds for a request that arrives after the build already started", async () => {
    // the edit behind req-2 may have landed after the running build read the
    // file, so it needs its own build rather than the in-flight one
    let queue!: BuildRequestQueue;
    let runs = 0;
    const replies: string[] = [];
    queue = new BuildRequestQueue(
      async () => {
        runs += 1;
        if (runs === 1) await queue.handleJob("req-2", 1);
      },
      async (id) => {
        replies.push(id);
      },
      () => false,
      1,
      2_000,
    );

    await queue.handleJob("req-1", 1);

    expect(runs).toBe(2);
    expect(replies).toEqual(["req-1", "req-2"]);
    expect(queue.isRunning()).toBe(false);
  });

  it("waits out a build started outside the queue rather than dropping the request", async () => {
    // the finding-4 case: a manual, save-triggered or browser-API build is
    // already running when a tagged request arrives
    let busy = true;
    const { queue, replies, runCount } = makeQueue({ busy: () => busy });

    const running = queue.handleJob("req-1", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(runCount()).toBe(0);
    expect(replies).toEqual([]);

    busy = false;
    await running;
    expect(runCount()).toBe(1);
    expect(replies).toEqual(["req-1"]);
  });

  it("still drains queued requests after a build throws", async () => {
    let queue!: BuildRequestQueue;
    let runs = 0;
    const replies: string[] = [];
    queue = new BuildRequestQueue(
      async () => {
        runs += 1;
        if (runs === 1) {
          await queue.handleJob("req-2", 1); // queued behind the doomed build
          throw Error("build blew up");
        }
      },
      async (id) => {
        replies.push(id);
      },
      () => false,
      1,
      2_000,
    );

    await queue.handleJob("req-1", 1);

    // the failing run must answer req-1 and must not strand req-2
    expect(runs).toBe(2);
    expect(replies).toEqual(["req-1", "req-2"]);
    expect(queue.isRunning()).toBe(false);
  });

  it("gives up if the editor never becomes idle", async () => {
    const { queue, replies, runCount } = makeQueue({ busy: () => true });
    const queueShortWait = new BuildRequestQueue(
      async () => {},
      async () => {},
      () => true,
      1,
      30,
    );
    await queueShortWait.handleJob("req-1", 1);
    expect(queueShortWait.isRunning()).toBe(false);
    expect(queueShortWait.pendingCount()).toBe(0);
    expect(runCount()).toBe(0);
    expect(replies).toEqual([]);
    void queue;
  });

  it("answers a repeated request id only once", async () => {
    let queue!: BuildRequestQueue;
    let runs = 0;
    const replies: string[] = [];
    queue = new BuildRequestQueue(
      async () => {
        runs += 1;
        if (runs === 1) {
          await queue.handleJob("req-2", 1);
          await queue.handleJob("req-2", 1);
        }
      },
      async (id) => {
        replies.push(id);
      },
      () => false,
      1,
      2_000,
    );
    await queue.handleJob("req-1", 1);
    expect(replies).toEqual(["req-1", "req-2"]);
  });
});

describe("BuildRequestQueue aggregate handling", () => {
  it("passes the requesting job's aggregate through to the build", async () => {
    // concurrent editors must attach to one backend execution, which only
    // happens if they all build at the same aggregate
    const seen: unknown[] = [];
    const queue = new BuildRequestQueue(
      async (aggregate) => {
        seen.push(aggregate);
      },
      async () => {},
      () => false,
      1,
      2_000,
    );
    await queue.handleJob("req-1", 4242);
    expect(seen).toEqual([4242]);
  });

  it("builds coalesced requests at the newest requested generation", async () => {
    let queue!: BuildRequestQueue;
    const seen: unknown[] = [];
    let runs = 0;
    queue = new BuildRequestQueue(
      async (aggregate) => {
        runs += 1;
        seen.push(aggregate);
        if (runs === 1) {
          await queue.handleJob("req-2", 200);
          await queue.handleJob("req-3", 300);
        }
      },
      async () => {},
      () => false,
      1,
      2_000,
    );
    await queue.handleJob("req-1", 100);
    expect(seen).toEqual([100, 300]);
  });

  it("stops waiting and builds nothing once cancelled", async () => {
    let busy = true;
    let runs = 0;
    const replies: string[] = [];
    const queue = new BuildRequestQueue(
      async () => {
        runs += 1;
      },
      async (id) => {
        replies.push(id);
      },
      () => busy,
      1,
      5_000,
    );
    const running = queue.handleJob("req-1", 1);
    await new Promise((r) => setTimeout(r, 15));
    queue.cancel();
    busy = false;
    await running;
    // a closed editor must not be built
    expect(runs).toBe(0);
    expect(replies).toEqual([]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("ignores requests that arrive after cancellation", async () => {
    let runs = 0;
    const queue = new BuildRequestQueue(
      async () => {
        runs += 1;
      },
      async () => {},
      () => false,
      1,
      2_000,
    );
    queue.cancel();
    await queue.handleJob("req-1", 1);
    expect(runs).toBe(0);
  });
});

describe("classifyBuildJob", () => {
  const job = (job_key?: string, aggregate?: any) =>
    ({ job_key, aggregate }) as any;

  it("accepts a request tagged for this editor's document", () => {
    expect(
      classifyBuildJob(
        job(buildRequestJobKey({ request_id: "r1", path: "/root/a.tex" })),
        "/root/a.tex",
      ),
    ).toEqual({ role: "request", request_id: "r1" });
  });

  it("separates a request for the other member of a knitr pair from a stage", () => {
    // paper.Rnw and its generated paper.tex share a build group, so both
    // editors see the job.  The .tex editor must recognise it as somebody
    // else's request and stay out: treating it as an ordinary stage would
    // start LaTeX on a file knitr is at that moment rewriting.
    const forRnw = job(
      buildRequestJobKey({ request_id: "r1", path: "/root/paper.Rnw" }),
    );
    expect(classifyBuildJob(forRnw, "/root/paper.Rnw")).toEqual({
      role: "request",
      request_id: "r1",
    });
    expect(classifyBuildJob(forRnw, "/root/paper.tex")).toEqual({
      role: "foreign-request",
    });
  });

  it("reports an untagged job as a stage", () => {
    expect(classifyBuildJob(job(undefined), "/root/a.tex")).toEqual({
      role: "stage",
    });
    expect(classifyBuildJob(job("latex:/root/a.tex"), "/root/a.tex")).toEqual({
      role: "stage",
    });
  });
});

describe("isOwnPipelineStage", () => {
  const job = (job_key?: string) => ({ job_key }) as any;

  it("lets a knitr editor join a peer at the knitr stage", () => {
    expect(
      isOwnPipelineStage(job("knitr:/root/paper.Rnw"), {
        logicalPath: "/root/paper.Rnw",
      }),
    ).toBe(true);
  });

  it("lets a knitr editor join a peer at a later stage too", () => {
    // this is what an editor opening or reconnecting mid-build sees: knitr is
    // long done, and the LaTeX stage is all there is left to recognize
    for (const key of [
      "latex:/root/paper.Rnw",
      "sagetex:/root/paper.Rnw",
      "pythontex:/root/paper.Rnw",
    ]) {
      expect(
        isOwnPipelineStage(job(key), { logicalPath: "/root/paper.Rnw" }),
      ).toBe(true);
    }
  });

  it("keeps a knitr editor from re-knitting under a plain LaTeX build", () => {
    // somebody is compiling the generated .tex; re-knitting now would rewrite
    // the file being compiled
    expect(
      isOwnPipelineStage(job("latex:/root/paper.tex"), {
        logicalPath: "/root/paper.Rnw",
      }),
    ).toBe(false);
  });

  it("keeps a .tex editor out of the knitr pipeline sharing its group", () => {
    for (const key of ["knitr:/root/paper.Rnw", "latex:/root/paper.Rnw"]) {
      expect(
        isOwnPipelineStage(job(key), { logicalPath: "/root/paper.tex" }),
      ).toBe(false);
    }
  });

  it("leaves editors that own their group alone", () => {
    expect(
      isOwnPipelineStage(job("latex:/root/a.tex"), {
        logicalPath: "/root/a.tex",
      }),
    ).toBe(true);
    expect(
      isOwnPipelineStage(job("rmd:/root/a.Rmd"), {
        logicalPath: "/root/a.Rmd",
      }),
    ).toBe(true);
  });

  it("gives a job that names no stage to the editor the group is named for", () => {
    // a bare trigger job identifies the group and nothing finer
    expect(isOwnPipelineStage(job(), { logicalPath: "/root/paper.tex" })).toBe(
      true,
    );
    expect(isOwnPipelineStage(job(), { logicalPath: "/root/paper.Rnw" })).toBe(
      false,
    );
  });

  it("ignores a stage belonging to a different document", () => {
    expect(
      isOwnPipelineStage(job("knitr:/root/other.Rnw"), {
        logicalPath: "/root/paper.Rnw",
      }),
    ).toBe(false);
  });
});

describe("buildStageIsPastKnitr", () => {
  const job = (job_key?: string) => ({ job_key }) as any;

  it("is false at the knitr stage itself", () => {
    expect(buildStageIsPastKnitr(job("knitr:/root/paper.Rnw"))).toBe(false);
  });

  it("is true once the generated .tex is being compiled", () => {
    // the joining editor must not knit again on top of that .tex
    expect(buildStageIsPastKnitr(job("latex:/root/paper.Rnw"))).toBe(true);
    expect(buildStageIsPastKnitr(job("sagetex:/root/paper.Rnw"))).toBe(true);
    expect(buildStageIsPastKnitr(job("pythontex:/root/paper.Rnw"))).toBe(true);
  });

  it("is false when the job names no stage", () => {
    expect(buildStageIsPastKnitr(job())).toBe(false);
    expect(buildStageIsPastKnitr(job("rmd:/root/a.Rmd"))).toBe(false);
  });
});

describe("untaggedBuildAggregate", () => {
  const job = (aggregate?: any) => ({ aggregate }) as any;

  it("follows another client's build at its own aggregate", () => {
    // this is why editors watch the group at all: entering our pipeline at the
    // aggregate of the build already running attaches us to its stages instead
    // of starting a second one
    expect(untaggedBuildAggregate(job(7), { busy: false })).toBe(7);
    expect(
      untaggedBuildAggregate(job({ value: "rev-a" }), { busy: false }),
    ).toBe("rev-a");
  });

  it("ignores jobs while this editor is building", () => {
    // while we build, the jobs in this group are our own stages; following
    // them would emit more stages, forever
    expect(untaggedBuildAggregate(job(7), { busy: true })).toBeUndefined();
  });

  it("ignores a job with no aggregate", () => {
    expect(
      untaggedBuildAggregate(job(undefined), { busy: false }),
    ).toBeUndefined();
  });

  it("ignores an opaque revision when only a timestamp will do", () => {
    // the LaTeX pipeline is driven by a time, not by knitr's { value } revision
    expect(
      untaggedBuildAggregate(job({ value: "rev-a" }), {
        busy: false,
        numericOnly: true,
      }),
    ).toBeUndefined();
    expect(
      untaggedBuildAggregate(job(7), { busy: false, numericOnly: true }),
    ).toBe(7);
  });
});

describe("jobAggregateValue", () => {
  it("unwraps both scalar and object aggregates", () => {
    expect(jobAggregateValue({ aggregate: 42 } as any)).toBe(42);
    expect(jobAggregateValue({ aggregate: { value: 42 } } as any)).toBe(42);
    expect(jobAggregateValue({} as any)).toBeUndefined();
  });
});

describe("selectBuildAggregate", () => {
  it("is independent of the order requests were delivered in", () => {
    // the watcher sequences per job and snapshot refresh can interleave with
    // live events, so two clients may see the same batch in opposite orders;
    // if they picked different aggregates they would not share one execution
    const batch = [100, 300, 200];
    expect(selectBuildAggregate(batch)).toBe(300);
    expect(selectBuildAggregate([...batch].reverse())).toBe(300);
    expect(selectBuildAggregate([300, 100, 200])).toBe(300);
  });

  it("takes the newest numeric generation", () => {
    expect(selectBuildAggregate([1, 2])).toBe(2);
    expect(selectBuildAggregate([2, 1])).toBe(2);
  });

  it("ignores missing values", () => {
    expect(selectBuildAggregate([undefined, 5, undefined])).toBe(5);
    expect(selectBuildAggregate([undefined, undefined])).toBeUndefined();
    expect(selectBuildAggregate([])).toBeUndefined();
  });

  it("is deterministic for opaque revisions too", () => {
    expect(selectBuildAggregate(["a", "c", "b"])).toBe("c");
    expect(selectBuildAggregate(["b", "c", "a"])).toBe("c");
    // an ordered generation beats an opaque revision, either way round
    expect(selectBuildAggregate(["zzz", 1])).toBe(1);
    expect(selectBuildAggregate([1, "zzz"])).toBe(1);
  });
});

describe("BuildRequestQueue coalescing determinism", () => {
  const runWith = async (order: number[]) => {
    let queue!: BuildRequestQueue;
    const seen: unknown[] = [];
    let runs = 0;
    queue = new BuildRequestQueue(
      async (aggregate) => {
        runs += 1;
        seen.push(aggregate);
        if (runs === 1) {
          for (const [i, agg] of order.entries()) {
            await queue.handleJob(`req-${i + 2}`, agg);
          }
        }
      },
      async () => {},
      () => false,
      1,
      2_000,
    );
    await queue.handleJob("req-1", 10);
    return seen;
  };

  it("builds identical batches at the same aggregate regardless of arrival order", async () => {
    expect(await runWith([100, 300, 200])).toEqual([10, 300]);
    expect(await runWith([200, 300, 100])).toEqual([10, 300]);
    expect(await runWith([300, 200, 100])).toEqual([10, 300]);
  });
});
