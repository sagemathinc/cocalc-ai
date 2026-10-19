/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Codex on #1134: from the project's owning bay, the board-decide request
// must reach the server that has the project's files. With real conat: a
// "host" server where the board-decide service runs, and the bay's own
// server, which has no such service. In the hosted runtime the bay's default
// client misses it (that was the bug); the client this module picks reaches
// it. In the workspace runtime the bay serves files itself, and the bay's
// client is the one.

let hosted = true;
jest.mock("@cocalc/project-runner/runtime-mode", () => ({
  isWorkspaceProjectRuntime: () => !hosted,
}));
let bayClient: any;
let hostClient: any;
const routedFor: string[] = [];
jest.mock("@cocalc/backend/conat", () => ({
  conat: () => bayClient,
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitProjectRoutedClient: async ({ project_id }) => {
    routedFor.push(project_id);
    return hostClient;
  },
}));

import { after, createServer } from "@cocalc/backend/conat/test/setup";
import { prepareBoardDecide } from "@cocalc/conat/project/board-decide";
import { initBoardDecideService } from "@cocalc/backend/sagebrush-board/service";
import { boardTextDigest } from "@cocalc/util/sagebrush-board";
import { boardDecideClient } from "./board-decide-route";

const PROJECT = "22222222-2222-4222-8222-222222222222";
const BOARD = JSON.stringify({
  format: "sagebrush-board",
  version: 1,
  title: "Primes",
  layout: "column",
  nodes: [
    {
      id: "q",
      kind: "ask",
      input: "text",
      title: "Is 7 prime?",
      text: "Say why.",
      decide: [
        { name: "says-seven-has-no-other-divisors" },
        { name: "thinks-seven-has-another-divisor" },
      ],
    },
  ],
});
const sandbox = {
  realpath: async (path: string) => `/home/user/${path}`,
  readRegularFileAuthorized: async () => BOARD,
};

const servers: any[] = [];
const clients: any[] = [];
const services: any[] = [];

beforeAll(async () => {
  const bay = await createServer({ clusterName: "bay" });
  const host = await createServer({ clusterName: "host" });
  servers.push(bay, host);
  bayClient = bay.client({ noCache: true, path: "/" });
  hostClient = host.client({ noCache: true, path: "/" });
  clients.push(bayClient, hostClient);
});

afterAll(async () => {
  for (const s of services) s.close?.();
  for (const c of clients) c.close?.();
  for (const s of servers) await s.close?.();
  // the harness's own teardown: every conat client and server it knows
  await after();
});

async function ask(client: any) {
  return await prepareBoardDecide({
    client,
    project_id: PROJECT,
    path: "primes.board.json",
    revision: "r1",
    sha256: await boardTextDigest(BOARD),
    message: {
      sagebrush: "decide",
      version: 1,
      id: "6b1f0c1e-2d3a-4f5b-8c7d-9e0f1a2b3c4d",
      name: "primes.board.json",
      revision: "r1",
      page: { number: 1 },
      item: "q",
      note: "only 1 and 7 divide it",
    },
  });
}

describe("hosted: the service is on the project's host only", () => {
  beforeAll(async () => {
    hosted = true;
    services.push(
      await initBoardDecideService(hostClient, {
        projectFilesystem: async () => sandbox,
      }),
    );
  });
  afterAll(() => services.splice(0).forEach((s) => s.close?.()));

  test("the bay's default client misses it (the bug)", async () => {
    await expect(ask(bayClient)).rejects.toBeTruthy();
  });

  test("the client chosen is routed to the project's host, and reaches it", async () => {
    routedFor.length = 0;
    const client = await boardDecideClient(PROJECT);
    expect(client).toBe(hostClient);
    expect(routedFor).toEqual([PROJECT]);
    const out = await ask(client);
    expect(out.request.prompt).toBe("Is 7 prime?\n\nSay why.");
  });
});

describe("workspace runtime: the bay serves the project's files itself", () => {
  beforeAll(async () => {
    hosted = false;
    services.push(
      await initBoardDecideService(bayClient, {
        projectFilesystem: async () => sandbox,
      }),
    );
  });
  afterAll(() => services.splice(0).forEach((s) => s.close?.()));

  test("the bay's own client, and no host route asked for", async () => {
    routedFor.length = 0;
    const client = await boardDecideClient(PROJECT);
    expect(client).toBe(bayClient);
    expect(routedFor).toEqual([]);
    const out = await ask(client);
    expect(out.request.answer).toBe("only 1 and 7 divide it");
  });
});
