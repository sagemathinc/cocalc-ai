/*

DEVELOPMENT:

pnpm test `pwd`/run-code.test.ts

*/

import {
  before,
  after,
  connect,
  delay,
  wait,
} from "@cocalc/backend/conat/test/setup";
import {
  jupyterClient,
  jupyterServer,
} from "@cocalc/conat/project/jupyter/run-code";
import { uuid } from "@cocalc/util/misc";

// it's really 100+, but tests fails if less than this.
const MIN_EVALS_PER_SECOND = 10;

beforeAll(before);

async function getKernelStatus(_opts: { path: string }) {
  return { backend_state: "off" as "off", kernel_state: "idle" as "idle" };
}

function withoutRunId(value: any): any {
  if (Array.isArray(value)) {
    return value.map(withoutRunId);
  }
  if (value != null && typeof value == "object") {
    const { run_id, ...rest } = value;
    return rest;
  }
  return value;
}

describe("create very simple mocked jupyter runner and test evaluating code", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  let server;
  const project_id = uuid();
  it("create jupyter code run server", () => {
    // running code with this just results in two responses: the path and the cells
    async function run({ path, cells }) {
      async function* runner() {
        yield { path, id: "0" };
        yield { cells, id: "0" };
      }
      return runner();
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      getKernelStatus,
    });
  });

  let client;
  const path = "a.ipynb";
  const cells = [{ id: "a", input: "2+3" }];
  it("create a jupyter client, then run some code", async () => {
    client = jupyterClient({ path, project_id, client: client2 });
    const iter = await client.run(cells);
    const v: any[] = [];
    for await (const output of iter) {
      v.push(...output);
    }
    expect(withoutRunId(v)).toEqual([
      { path, id: "0" },
      { cells, id: "0" },
    ]);
  });

  it("start iterating over the output after waiting", async () => {
    // this is the same as the previous test, except we insert a
    // delay from when we create the iterator, and when we start
    // reading values out of it.  This is important to test, because
    // it was broken in my first implementation, and is a common mistake
    // when implementing async iterators.
    client.verbose = true;
    const iter = await client.run(cells);
    const v: any[] = [];
    await delay(500);
    for await (const output of iter) {
      v.push(...output);
    }
    expect(withoutRunId(v)).toEqual([
      { path, id: "0" },
      { cells, id: "0" },
    ]);
  });

  const count = 100;
  it(`run ${count} evaluations to ensure that the speed is reasonable (and also everything is kept properly ordered, etc.)`, async () => {
    const start = Date.now();
    for (let i = 0; i < count; i++) {
      const v: any[] = [];
      const cells = [{ id: `${i}`, input: `${i} + ${i}` }];
      for await (const output of await client.run(cells)) {
        v.push(...output);
      }
      expect(withoutRunId(v)).toEqual([
        { path, id: "0" },
        { cells, id: "0" },
      ]);
    }
    const evalsPerSecond = Math.floor((1000 * count) / (Date.now() - start));
    if (process.env.BENCH) {
      console.log({ evalsPerSecond });
    }
    expect(evalsPerSecond).toBeGreaterThan(MIN_EVALS_PER_SECOND);
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("create simple mocked jupyter runner that does actually eval an expression", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  let server;
  const project_id = uuid();
  it("create jupyter code run server", () => {
    // running code with this just results in two responses: the path and the cells
    async function run({ cells }) {
      async function* runner() {
        for (const { id, input } of cells) {
          yield { id, output: eval(input) };
        }
      }
      return runner();
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      getKernelStatus,
    });
  });

  let client;
  const path = "b.ipynb";
  const cells = [
    { id: "a", input: "2+3" },
    { id: "b", input: "3**5" },
  ];
  it("create a jupyter client, then run some code", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });
    const iter = await client.run(cells);
    const v: any[] = [];
    for await (const output of iter) {
      v.push(...output);
    }
    expect(withoutRunId(v)).toEqual([
      { id: "a", output: 5 },
      { id: "b", output: 243 },
    ]);
  });

  it("run code that FAILS and see error is visible to client properly", async () => {
    const iter = await client.run([
      { id: "a", input: "2+3" },
      { id: "b", input: "2+invalid" },
    ]);
    try {
      for await (const _ of iter) {
      }
    } catch (err) {
      expect(`${err}`).toContain("ReferenceError: invalid is not defined");
    }
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("create mocked jupyter runner that does failover to backend output management when client disconnects", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  const path = "b.ipynb";
  const cells = [
    { id: "a", input: "10*(2+3)" },
    { id: "b", input: "100" },
  ];
  let server;
  const project_id = uuid();
  let handler: any = null;

  it("create jupyter code run server that also takes as long as the output to run", () => {
    async function run({ cells }) {
      async function* runner() {
        for (const { id, input } of cells) {
          const output = eval(input);
          await delay(output);
          yield { id, output };
        }
      }
      return runner();
    }

    class OutputHandler {
      messages: any[] = [];

      constructor(public cells) {}

      process = (mesg: any) => {
        this.messages.push(mesg);
      };
      done = () => {
        this.messages.push({ done: true });
      };
    }

    function outputHandler({ path: path0, cells }) {
      if (path0 != path) {
        throw Error(`path must be ${path}`);
      }
      handler = new OutputHandler(cells);
      return handler;
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      outputHandler,
      getKernelStatus,
    });
  });

  let client;
  it("create a jupyter client, then run some code (doesn't use output handler)", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });
    const iter = await client.run(cells);
    const v: any[] = [];
    for await (const output of iter) {
      v.push(output);
    }
    expect(withoutRunId(v)).toEqual([
      [{ id: "a", output: 50 }],
      [{ id: "b", output: 100 }],
    ]);
  });

  it("starts code running then closes the client, which causes output to have to be placed in the handler instead.", async () => {
    await client.run(cells);
    client.close();
    await wait({
      until: () => {
        return handler.messages.length >= 3;
      },
    });
    expect(withoutRunId(handler.messages)).toEqual([
      { id: "a", output: 50 },
      { id: "b", output: 100 },
      { done: true },
    ]);
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("fallback replay applies output limit correctly after disconnect", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  const path = "c.ipynb";
  const project_id = uuid();
  let server;
  let handler: any = null;
  let produced = 0;

  it("create jupyter code run server", () => {
    async function run({ cells }) {
      async function* runner() {
        for (const { id } of cells) {
          for (let i = 0; i < 40; i++) {
            produced += 1;
            yield { id, output: i };
            await delay(5);
          }
        }
      }
      return runner();
    }

    class OutputHandler {
      messages: any[] = [];
      process = (mesg: any) => {
        this.messages.push(mesg);
      };
      done = () => {
        this.messages.push({ done: true });
      };
    }

    function outputHandler({ path: path0 }) {
      if (path0 != path) {
        throw Error(`path must be ${path}`);
      }
      handler = new OutputHandler();
      return handler;
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      outputHandler,
      getKernelStatus,
    });
  });

  let client;
  it("disconnect after limit is exceeded, then replay through fallback", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });

    await client.run([{ id: "cell-a", input: "x" }], { limit: 5 });
    await wait({
      until: () => produced >= 20,
    });

    client.close();

    await wait({
      until: () => handler?.messages?.some((m) => m?.done),
    });

    const messages = withoutRunId(handler.messages);
    expect(messages).toContainEqual({ id: "cell-a", output: 0 });
    expect(messages).toContainEqual({ id: "cell-a", more_output: true });
    expect(messages).toContainEqual({ done: true });
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("coalesces adjacent stream messages before applying limit", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  const path = "d.ipynb";
  const project_id = uuid();
  let server;

  it("create jupyter code run server", () => {
    async function run({ cells }) {
      async function* runner() {
        for (const { id } of cells) {
          for (let i = 0; i < 200; i++) {
            yield {
              id,
              msg_type: "stream",
              content: { name: "stdout", text: `${i} ` },
            };
          }
        }
      }
      return runner();
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      getKernelStatus,
    });
  });

  let client;
  it("stream output is coalesced so tiny flushes do not trigger more_output", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });
    const outputs: any[] = [];
    const iter = await client.run([{ id: "cell-a", input: "x" }], { limit: 5 });
    for await (const batch of iter) {
      outputs.push(...batch);
    }
    const stream = outputs.filter((x) => x.msg_type === "stream");
    // The first chunk may be fast-laned for latency, so stream output can
    // arrive split into two coalesced chunks instead of one.
    expect(stream.length).toBeGreaterThan(0);
    expect(stream.length).toBeLessThanOrEqual(2);
    for (const s of stream) {
      expect(s).toMatchObject({
        id: "cell-a",
        msg_type: "stream",
        content: { name: "stdout" },
      });
    }
    const allText = stream.map((x) => x.content?.text ?? "").join("");
    expect(allText).toContain("0 ");
    expect(allText).toContain("199 ");
    expect(outputs.some((x) => x.more_output)).toBe(false);
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("rapid rerun drops stale run output by run_id", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  const path = "rapid.ipynb";
  const project_id = uuid();
  let server;

  it("create jupyter code run server with delayed output", () => {
    async function run({ cells }) {
      async function* runner() {
        for (let i = 0; i < 40; i++) {
          await delay(4);
          yield {
            id: cells[0].id,
            msg_type: "stream",
            content: { name: "stdout", text: `${i} ` },
          };
        }
      }
      return runner();
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      getKernelStatus,
    });
  });

  let client;
  it("second run receives only its own run_id output", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });

    await client.run([{ id: "cell-a", input: "x" }], {
      run_id: "rapid-1",
      waitForAck: false,
    });
    await delay(25);
    const iter2 = await client.run([{ id: "cell-a", input: "x" }], {
      run_id: "rapid-2",
      waitForAck: false,
    });
    const outputs: any[] = [];
    for await (const batch of iter2) {
      outputs.push(...batch);
    }
    expect(outputs.length).toBeGreaterThan(0);
    expect(new Set(outputs.map((x) => x.run_id))).toEqual(new Set(["rapid-2"]));
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

describe("lifecycle messages are explicit and survive limit/disconnect flows", () => {
  let client1, client2;
  it("create two clients", async () => {
    client1 = connect();
    client2 = connect();
  });

  const path = "lifecycle.ipynb";
  const project_id = uuid();
  let server;
  let handler: any = null;

  it("create jupyter code run server that emits explicit lifecycle messages", () => {
    async function run({ cells, run_id }) {
      async function* runner() {
        yield { msg_type: "run_start", lifecycle: "run_start", run_id };
        for (const { id } of cells) {
          yield { id, msg_type: "cell_start", lifecycle: "cell_start", run_id };
          for (let i = 0; i < 6; i++) {
            yield {
              id,
              msg_type: "stream",
              content: { name: "stdout", text: `${i} ` },
            };
            await delay(5);
          }
          yield { id, msg_type: "cell_done", lifecycle: "cell_done", run_id };
        }
        yield { msg_type: "run_done", lifecycle: "run_done", run_id };
      }
      return runner();
    }

    class OutputHandler {
      messages: any[] = [];
      process = (mesg: any) => {
        this.messages.push(mesg);
      };
      done = () => {
        this.messages.push({ done: true });
      };
    }

    function outputHandler({ path: path0 }) {
      if (path0 != path) {
        throw Error(`path must be ${path}`);
      }
      handler = new OutputHandler();
      return handler;
    }

    server = jupyterServer({
      client: client1,
      project_id,
      run,
      outputHandler,
      getKernelStatus,
    });
  });

  let client;
  it("lifecycle events are delivered even when output limit is exceeded", async () => {
    client = jupyterClient({
      path,
      project_id,
      client: client2,
    });
    const outputs: any[] = [];
    const iter = await client.run([{ id: "cell-a", input: "x" }], {
      run_id: "life-1",
      limit: 2,
    });
    for await (const batch of iter) {
      outputs.push(...batch);
    }
    const lifecycle = outputs
      .map((x) => x.lifecycle ?? x.msg_type)
      .filter((x) => typeof x == "string");
    expect(lifecycle).toEqual(
      expect.arrayContaining(["run_start", "cell_start", "cell_done", "run_done"]),
    );
    const streamIndex = outputs.findIndex((x) => x.msg_type === "stream");
    const cellDoneIndex = outputs.findIndex(
      (x) => (x.lifecycle ?? x.msg_type) === "cell_done",
    );
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(cellDoneIndex).toBeGreaterThan(streamIndex);
  });

  it("lifecycle events keep fallback output handler state consistent after disconnect", async () => {
    await client.run([{ id: "cell-b", input: "x" }], {
      run_id: "life-2",
      waitForAck: false,
    });
    await delay(20);
    client.close();
    await wait({
      until: () => handler?.messages?.some((m) => m?.done),
    });
    const messages = withoutRunId(handler.messages);
    expect(messages).toContainEqual(
      expect.objectContaining({ id: "cell-b", done: true }),
    );
    expect(messages).toContainEqual({ done: true });
  });

  it("cleans up", () => {
    server.close();
    client.close();
  });
});

afterAll(after);
