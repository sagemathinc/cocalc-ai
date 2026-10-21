/*
A fence that is never released makes its project's documents impossible to
open: both sides say so in the log while it is held long, in words that tell
a person what holds it (conat/persist/fence.ts).

pnpm test ./fence-warnings.test.ts
*/

// what the fence module warns about
const mockWarnings: { message: string; info: any }[] = [];
jest.mock("@cocalc/conat/logger", () => {
  const actual = jest.requireActual("@cocalc/conat/logger");
  return {
    ...actual,
    getLogger: (name: string) => {
      const logger = actual.getLogger(name);
      if (name !== "persist:fence") return logger;
      return {
        ...logger,
        warn: (message: unknown, info: unknown) => {
          mockWarnings.push({ message: `${message}`, info });
        },
      };
    },
  };
});

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import {
  initPersistFenceService,
  withPersistFence,
} from "@cocalc/conat/persist/fence";
import { currentFenceHolder } from "@cocalc/backend/conat/persist-fence";
import { uuid } from "@cocalc/util/misc";

const warnings = mockWarnings;

beforeAll(before);
afterAll(after);

jest.setTimeout(30000);

describe("a fence held long is logged, with what holds it", () => {
  const project_id = uuid();
  let service: Awaited<ReturnType<typeof initPersistFenceService>>;

  afterAll(() => service?.close());

  it("by the persist server and by its holder, ever less often", async () => {
    service = await initPersistFenceService({
      client: connect(),
      holderAlive: () => true,
      // a holder that is gone, kept by what it started
      describeHolder: () => ({
        holder_running: false,
        keeping: [{ pid: 4242, command: "rustic restore" }],
      }),
      holderCheckMs: 10,
      longFenceMs: 50,
    });
    await withPersistFence(
      {
        client: connect(),
        project_id,
        holder: currentFenceHolder(),
        reason: "restore-backup",
        replaces: false,
        longFenceMs: 50,
      },
      async () => await new Promise((resolve) => setTimeout(resolve, 400)),
    );
    const server = warnings.filter((w) => w.message.includes("held for"));
    expect(server.length).toBeGreaterThanOrEqual(1);
    // (not every check: 40 of them)
    expect(server.length).toBeLessThanOrEqual(5);
    expect(server[0].message).toContain(project_id);
    expect(server[0].message).toContain("is gone");
    expect(server[0].info).toMatchObject({
      project_id,
      reason: "restore-backup",
      keeping: [{ pid: 4242, command: "rustic restore" }],
    });
    const holder = warnings.filter((w) => w.message.includes("still holding"));
    expect(holder.length).toBeGreaterThanOrEqual(1);
    expect(holder.length).toBeLessThanOrEqual(4);
    expect(holder[0].message).toContain("restore-backup");
  });
});
