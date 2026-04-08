/*
 * Benchmark the Conat router using the same in-process server bootstrap that
 * Phase 5 would rely on.
 *
 * Typical usage:
 *
 *   cd src/packages/backend
 *   pnpm exec tsc --build
 *   node dist/conat/benchmark.js
 *
 *   # quicker smoke run
 *   node dist/conat/benchmark.js --messages 2000 --rpc-requests 400
 *
 *   # JSON output for later analysis
 *   node dist/conat/benchmark.js --json > /tmp/conat-bench.json
 */

import getPort from "@cocalc/backend/get-port";
import "@cocalc/backend/conat/persist";
import { connect, type Client, type Message } from "@cocalc/conat/core/client";
import {
  init as createConatServer,
  type ConatServer,
} from "@cocalc/conat/core/server";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";

type ScenarioKind = "pubsub" | "rpc";

interface BenchOptions {
  messages: number;
  rpcRequests: number;
  rpcConcurrency: number;
  payloadBytes: number;
  idleSubscriptionsPerClient: number;
  clusterSize: number;
  workerClusterSize: number;
  includeForkedWorkers: boolean;
  json: boolean;
}

interface BaseResult {
  scenario: string;
  kind: ScenarioKind;
  topology: string;
  cluster_size: number;
  payload_bytes: number;
}

interface PubSubResult extends BaseResult {
  kind: "pubsub";
  messages: number;
  recipients: number;
  send_mps: number;
  recv_mps: number;
  send_ms: number;
  recv_ms: number;
  idle_subscriptions_per_client: number;
}

interface RpcResult extends BaseResult {
  kind: "rpc";
  requests: number;
  concurrency: number;
  total_mps: number;
  total_ms: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  latency_p99_ms: number;
}

type ScenarioResult = PubSubResult | RpcResult;

interface BenchHarness {
  topology: string;
  servers: ConatServer[];
  clients: Client[];
  close: () => Promise<void>;
}

const DEFAULT_OPTIONS: BenchOptions = {
  messages: 10_000,
  rpcRequests: 2_000,
  rpcConcurrency: 32,
  payloadBytes: 128,
  idleSubscriptionsPerClient: 400,
  clusterSize: 4,
  workerClusterSize: 4,
  includeForkedWorkers: false,
  json: false,
};

const SYSTEM_PASSWORD = "conat-benchmark";
const PATH = "/conat";

function usage(): never {
  console.log(`Usage: node dist/conat/benchmark.js [options]

Options:
  --messages <n>                  Pub/sub message count (default: ${DEFAULT_OPTIONS.messages})
  --rpc-requests <n>              RPC request count (default: ${DEFAULT_OPTIONS.rpcRequests})
  --rpc-concurrency <n>           RPC concurrency (default: ${DEFAULT_OPTIONS.rpcConcurrency})
  --payload-bytes <n>             Message payload size (default: ${DEFAULT_OPTIONS.payloadBytes})
  --idle-subscriptions <n>        Extra exact subscriptions per client (default: ${DEFAULT_OPTIONS.idleSubscriptionsPerClient})
  --cluster-size <n>              Same-process cluster size (default: ${DEFAULT_OPTIONS.clusterSize})
  --worker-cluster-size <n>       Forked worker cluster size (default: ${DEFAULT_OPTIONS.workerClusterSize})
  --forked-workers                Also benchmark the experimental forked-worker topology
  --json                          Emit JSON instead of a human table
  --help                          Show this help
`);
  process.exit(0);
}

function parseArgs(argv: string[]): BenchOptions {
  const opts = { ...DEFAULT_OPTIONS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    }
    const next = () => {
      const value = argv[++i];
      if (value == null) {
        throw new Error(`missing value after ${arg}`);
      }
      return value;
    };
    switch (arg) {
      case "--messages":
        opts.messages = parsePositiveInt(next(), arg);
        break;
      case "--rpc-requests":
        opts.rpcRequests = parsePositiveInt(next(), arg);
        break;
      case "--rpc-concurrency":
        opts.rpcConcurrency = parsePositiveInt(next(), arg);
        break;
      case "--payload-bytes":
        opts.payloadBytes = parseNonNegativeInt(next(), arg);
        break;
      case "--idle-subscriptions":
        opts.idleSubscriptionsPerClient = parseNonNegativeInt(next(), arg);
        break;
      case "--cluster-size":
        opts.clusterSize = parsePositiveInt(next(), arg);
        break;
      case "--worker-cluster-size":
        opts.workerClusterSize = parsePositiveInt(next(), arg);
        break;
      case "--forked-workers":
        opts.includeForkedWorkers = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseNonNegativeInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

function hrNow(): bigint {
  return process.hrtime.bigint();
}

function hrElapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function round(n: number, places = 2): number {
  return Number(n.toFixed(places));
}

function ratePerSecond(count: number, elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return count;
  }
  return round((count / elapsedMs) * 1000);
}

async function waitUntil(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 15_000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }
    await delay(pollMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function payload(payloadBytes: number): string | null {
  if (payloadBytes <= 0) {
    return null;
  }
  return "x".repeat(payloadBytes);
}

function isExpectedShutdownError(err: unknown): boolean {
  const text =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    text.includes("socket has been disconnected") ||
    text.includes("subscription is closed") ||
    text.includes("client is closed")
  );
}

process.on("unhandledRejection", (reason) => {
  if (isExpectedShutdownError(reason)) {
    return;
  }
  console.error(
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
  process.exitCode = 1;
});

async function createServer(opts: {
  port?: number;
  id: string;
  clusterName?: string;
  autoscanInterval?: number;
  systemAccountPassword?: string;
  localClusterSize?: number;
}): Promise<ConatServer> {
  const port = opts.port ?? (await getPort());
  const server = createConatServer({
    port,
    path: PATH,
    id: opts.id,
    clusterName: opts.clusterName,
    autoscanInterval: opts.autoscanInterval ?? 0,
    systemAccountPassword: opts.systemAccountPassword ?? SYSTEM_PASSWORD,
    localClusterSize: opts.localClusterSize,
  });
  if (server.state !== "ready") {
    await new Promise<void>((resolve) => server.once("ready", () => resolve()));
  }
  return server;
}

async function createClient(address: string): Promise<Client> {
  const client = connect({
    address,
    noCache: true,
    systemAccountPassword: SYSTEM_PASSWORD,
  });
  await client.waitUntilSignedIn();
  return client;
}

async function createSingleServerHarness(): Promise<BenchHarness> {
  const server = await createServer({ id: "single-0" });
  const clients = await Promise.all([
    createClient(server.address()),
    createClient(server.address()),
  ]);
  return {
    topology: "single-server",
    servers: [server],
    clients,
    close: async () => {
      await closeClients(clients);
      await server.close();
    },
  };
}

async function createSameProcessClusterHarness(
  clusterSize: number,
): Promise<BenchHarness> {
  const clusterName = `bench-${randomUUID()}`;
  const servers: ConatServer[] = [];
  for (let i = 0; i < clusterSize; i++) {
    servers.push(
      await createServer({
        id: `node-${i}`,
        clusterName,
        autoscanInterval: 0,
      }),
    );
  }
  for (let i = 0; i < servers.length; i++) {
    for (let j = 0; j < servers.length; j++) {
      if (i !== j) {
        await servers[i].join(servers[j].address());
      }
    }
  }
  const clients = await Promise.all([
    createClient(servers[0].address()),
    createClient(servers[servers.length - 1].address()),
  ]);
  return {
    topology: `same-process-cluster-${clusterSize}`,
    servers,
    clients,
    close: async () => {
      await closeClients(clients);
      await Promise.all(servers.map(async (server) => await server.close()));
    },
  };
}

async function createWorkerClusterHarness(
  clusterSize: number,
): Promise<BenchHarness | null> {
  const childEntrypoint = join(
    process.cwd(),
    "..",
    "server",
    "dist",
    "conat",
    "socketio",
    "start-cluster-node.js",
  );
  try {
    await access(childEntrypoint);
  } catch {
    return null;
  }
  const clusterName = `bench-workers-${randomUUID()}`;
  const root = await createServer({
    id: "root",
    clusterName,
    localClusterSize: clusterSize,
  });
  await waitUntil(
    () => root.clusterAddresses(clusterName).length >= clusterSize,
  );
  const addresses = root.clusterAddresses(clusterName).sort();
  const clients = await Promise.all([
    createClient(addresses[0]),
    createClient(addresses[addresses.length - 1]),
  ]);
  return {
    topology: `forked-worker-cluster-${clusterSize}`,
    servers: [root],
    clients,
    close: async () => {
      await closeClients(clients);
      await root.close();
    },
  };
}

async function closeClients(clients: Client[]): Promise<void> {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // best-effort cleanup for benchmark clients
    }
  }
  await delay(100);
}

async function addIdleSubscriptions(
  clients: Client[],
  perClient: number,
  prefix: string,
): Promise<Array<{ close: () => void }>> {
  if (perClient <= 0) {
    return [];
  }
  const subs: Array<{ close: () => void }> = [];
  for (let clientIndex = 0; clientIndex < clients.length; clientIndex++) {
    for (let i = 0; i < perClient; i++) {
      const subject = `${prefix}.${clientIndex}.${i}`;
      subs.push(await clients[clientIndex].subscribe(subject));
    }
  }
  const readySubject = `${prefix}.${clients.length - 1}.${perClient - 1}`;
  const readyToken = `__ready__${randomUUID()}`;
  await waitUntil(
    async () => (await clients[0].publish(readySubject, readyToken)).count > 0,
  );
  return subs;
}

async function benchmarkPubSub(args: {
  scenario: string;
  topology: string;
  clusterSize: number;
  clients: [Client, Client];
  servers: ConatServer[];
  messages: number;
  payloadBytes: number;
  idleSubscriptionsPerClient: number;
}): Promise<PubSubResult> {
  const [subscriberClient, publisherClient] = args.clients;
  const subject = `bench.pubsub.${randomUUID()}`;
  const idleSubs = await addIdleSubscriptions(
    [subscriberClient, publisherClient],
    args.idleSubscriptionsPerClient,
    `${subject}.idle`,
  );
  const sub = await subscriberClient.subscribe(subject);
  const body = payload(args.payloadBytes);
  const readyToken = `__ready__${randomUUID()}`;
  await waitUntil(
    async () => (await publisherClient.publish(subject, readyToken)).count > 0,
  );

  const recvStart = hrNow();
  const recvDone = (async () => {
    try {
      let count = 0;
      for await (const mesg of sub) {
        if (mesg.data === readyToken) {
          continue;
        }
        count += 1;
        if (count >= args.messages) {
          sub.stop();
          break;
        }
      }
    } catch (err) {
      if (!isExpectedShutdownError(err)) {
        throw err;
      }
    }
    return hrElapsedMs(recvStart);
  })();

  const sendStart = hrNow();
  for (let i = 0; i < args.messages - 1; i++) {
    publisherClient.publishSync(subject, body);
  }
  const publishInfo = await publisherClient.publish(subject, body);
  const sendMs = hrElapsedMs(sendStart);
  const recvMs = await recvDone;

  for (const idleSub of idleSubs) {
    idleSub.close();
  }

  return {
    scenario: args.scenario,
    kind: "pubsub",
    topology: args.topology,
    cluster_size: args.clusterSize,
    payload_bytes: args.payloadBytes,
    messages: args.messages,
    recipients: publishInfo.count,
    send_mps: ratePerSecond(args.messages, sendMs),
    recv_mps: ratePerSecond(args.messages, recvMs),
    send_ms: round(sendMs),
    recv_ms: round(recvMs),
    idle_subscriptions_per_client: args.idleSubscriptionsPerClient,
  };
}

async function benchmarkRpc(args: {
  scenario: string;
  topology: string;
  clusterSize: number;
  clients: [Client, Client];
  servers: ConatServer[];
  requests: number;
  concurrency: number;
  payloadBytes: number;
}): Promise<RpcResult> {
  const [caller, callee] = args.clients;
  const subject = `bench.rpc.${randomUUID()}`;
  const body = payload(args.payloadBytes) ?? "";
  const sub = await callee.subscribe(subject);
  const readyToken = `__ready__${randomUUID()}`;
  await waitUntil(
    async () => (await caller.publish(subject, readyToken)).count > 0,
  );

  let closed = false;
  const responder = (async () => {
    try {
      for await (const mesg of sub) {
        if (closed) {
          break;
        }
        if (!(mesg as Message).isRequest()) {
          continue;
        }
        (mesg as Message).respond((mesg.data as string | null) ?? "");
      }
    } catch (err) {
      if (!isExpectedShutdownError(err)) {
        throw err;
      }
    }
  })();

  const latencies: number[] = new Array(args.requests);
  const start = hrNow();
  const workers = Math.min(args.concurrency, args.requests);
  await Promise.all(
    Array.from({ length: workers }, async (_, workerIndex) => {
      for (let i = workerIndex; i < args.requests; i += workers) {
        const t0 = hrNow();
        const resp = await caller.request(subject, body);
        latencies[i] = hrElapsedMs(t0);
        if (resp.data !== body) {
          throw new Error("rpc response mismatch");
        }
      }
    }),
  );
  const totalMs = hrElapsedMs(start);
  closed = true;
  sub.stop();
  await responder;

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    scenario: args.scenario,
    kind: "rpc",
    topology: args.topology,
    cluster_size: args.clusterSize,
    payload_bytes: args.payloadBytes,
    requests: args.requests,
    concurrency: workers,
    total_mps: ratePerSecond(args.requests, totalMs),
    total_ms: round(totalMs),
    latency_p50_ms: percentile(sorted, 0.5),
    latency_p95_ms: percentile(sorted, 0.95),
    latency_p99_ms: percentile(sorted, 0.99),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * p) - 1),
  );
  return round(sorted[index]);
}

function toJson(
  results: ScenarioResult[],
  options: BenchOptions,
): Record<string, unknown> {
  return {
    generated_at: new Date().toISOString(),
    options,
    results,
  };
}

function printResults(results: ScenarioResult[]): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    [
      "Scenario".padEnd(34),
      "Kind".padEnd(8),
      "Topology".padEnd(26),
      "Rate".padEnd(24),
      "Detail",
    ].join("  "),
  );
  lines.push("-".repeat(118));
  for (const result of results) {
    const rate =
      result.kind === "pubsub"
        ? `send ${result.send_mps}/s recv ${result.recv_mps}/s`
        : `${result.total_mps}/s`;
    const detail =
      result.kind === "pubsub"
        ? `${result.messages} msgs, ${result.payload_bytes} B, idle/client=${result.idle_subscriptions_per_client}`
        : `${result.requests} req, c=${result.concurrency}, p95=${result.latency_p95_ms}ms, p99=${result.latency_p99_ms}ms`;
    lines.push(
      [
        result.scenario.padEnd(34),
        result.kind.padEnd(8),
        result.topology.padEnd(26),
        rate.padEnd(24),
        detail,
      ].join("  "),
    );
  }
  lines.push("");
  console.log(lines.join("\n"));
}

async function runAll(options: BenchOptions): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];

  {
    const harness = await createSingleServerHarness();
    try {
      results.push(
        await benchmarkPubSub({
          scenario: "single_server_pubsub",
          topology: harness.topology,
          clusterSize: harness.servers.length,
          clients: harness.clients as [Client, Client],
          servers: harness.servers,
          messages: options.messages,
          payloadBytes: options.payloadBytes,
          idleSubscriptionsPerClient: 0,
        }),
      );
      results.push(
        await benchmarkRpc({
          scenario: "single_server_rpc",
          topology: harness.topology,
          clusterSize: harness.servers.length,
          clients: harness.clients as [Client, Client],
          servers: harness.servers,
          requests: options.rpcRequests,
          concurrency: options.rpcConcurrency,
          payloadBytes: options.payloadBytes,
        }),
      );
    } finally {
      await harness.close();
    }
  }

  {
    const harness = await createSameProcessClusterHarness(options.clusterSize);
    try {
      results.push(
        await benchmarkPubSub({
          scenario: "same_process_cluster_pubsub",
          topology: harness.topology,
          clusterSize: harness.servers.length,
          clients: harness.clients as [Client, Client],
          servers: harness.servers,
          messages: options.messages,
          payloadBytes: options.payloadBytes,
          idleSubscriptionsPerClient: 0,
        }),
      );
      results.push(
        await benchmarkPubSub({
          scenario: "same_process_cluster_pubsub_many_subscriptions",
          topology: harness.topology,
          clusterSize: harness.servers.length,
          clients: harness.clients as [Client, Client],
          servers: harness.servers,
          messages: options.messages,
          payloadBytes: options.payloadBytes,
          idleSubscriptionsPerClient: options.idleSubscriptionsPerClient,
        }),
      );
      results.push(
        await benchmarkRpc({
          scenario: "same_process_cluster_rpc",
          topology: harness.topology,
          clusterSize: harness.servers.length,
          clients: harness.clients as [Client, Client],
          servers: harness.servers,
          requests: options.rpcRequests,
          concurrency: options.rpcConcurrency,
          payloadBytes: options.payloadBytes,
        }),
      );
    } finally {
      await harness.close();
    }
  }

  const workerHarness = options.includeForkedWorkers
    ? await createWorkerClusterHarness(options.workerClusterSize)
    : null;
  if (workerHarness != null) {
    try {
      results.push(
        await benchmarkPubSub({
          scenario: "forked_worker_cluster_pubsub",
          topology: workerHarness.topology,
          clusterSize: options.workerClusterSize,
          clients: workerHarness.clients as [Client, Client],
          servers: workerHarness.servers,
          messages: options.messages,
          payloadBytes: options.payloadBytes,
          idleSubscriptionsPerClient: 0,
        }),
      );
      results.push(
        await benchmarkRpc({
          scenario: "forked_worker_cluster_rpc",
          topology: workerHarness.topology,
          clusterSize: options.workerClusterSize,
          clients: workerHarness.clients as [Client, Client],
          servers: workerHarness.servers,
          requests: options.rpcRequests,
          concurrency: options.rpcConcurrency,
          payloadBytes: options.payloadBytes,
        }),
      );
    } finally {
      await workerHarness.close();
    }
  }

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const results = await runAll(options);
  if (options.json) {
    console.log(JSON.stringify(toJson(results, options), null, 2));
  } else {
    printResults(results);
  }
  await delay(25);
}

void main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });
