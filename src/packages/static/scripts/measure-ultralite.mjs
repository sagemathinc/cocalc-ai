#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const NETWORK = {
  downloadThroughput: 1_400_000 / 8,
  uploadThroughput: 750_000 / 8,
  latency: 150,
  offline: false,
};

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  narrow: { width: 390, height: 844 },
  small: { width: 320, height: 720 },
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inline] = arg.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (inline != null) result[rawKey] = inline;
    else if (next && !next.startsWith("--")) {
      result[rawKey] = next;
      i += 1;
    } else result[rawKey] = true;
  }
  return result;
}

function required(args, name) {
  const value = `${args[name] ?? ""}`.trim();
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function ultraliteUrl(base, hash) {
  const url = new URL(base);
  if (!url.pathname.endsWith("ultralite.html")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/static/ultralite.html`;
  }
  url.hash = hash;
  return url.toString();
}

function projectHash(projectId, kind, path) {
  const root = `#/project/${projectId}`;
  if (kind === "files") {
    return `${root}/files?${new URLSearchParams({ path: path || "/home/user" })}`;
  }
  if (kind === "file") {
    return `${root}/file?${new URLSearchParams({ path })}`;
  }
  return `${root}/${kind}`;
}

function scenarios(args) {
  const rows = [
    {
      name: "projects",
      hash: "#/projects",
      selector: ".ul-project-row, .ul-empty",
      sloMs: 5_000,
    },
  ];
  const projectId = `${args["project-id"] ?? ""}`.trim();
  if (!projectId) return rows;
  rows.push({
    name: "files",
    hash: projectHash(projectId, "files", "/home/user"),
    selector: ".ul-file-row, .ul-empty",
    sloMs: 5_000,
  });
  for (const [name, option, sloMs] of [
    ["file", "file", 3_000],
    ["notebook", "notebook", 4_000],
  ]) {
    const path = `${args[option] ?? ""}`.trim();
    if (path) {
      rows.push({
        name,
        hash: projectHash(projectId, "file", path),
        selector:
          name === "notebook"
            ? ".ul-notebook .ul-cell, .ul-empty"
            : ".ul-code, .ul-editor",
        sloMs,
      });
    }
  }
  const chatPath = `${args["chat-path"] ?? ""}`.trim();
  const threadId = `${args["thread-id"] ?? ""}`.trim();
  if (chatPath && threadId) {
    rows.push({
      name: "chat",
      hash: `${projectHash(projectId, "chat")}?${new URLSearchParams({ path: chatPath, thread: threadId })}`,
      selector: ".ul-message, .ul-empty",
      sloMs: 5_000,
    });
  }
  return rows;
}

async function configure(page, { cpuRate, disableCache }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: disableCache });
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  if (cpuRate > 1) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  }
  const network = {
    encoded_bytes: 0,
    request_count: 0,
    websocket_received_bytes: 0,
    websocket_sent_bytes: 0,
  };
  cdp.on("Network.requestWillBeSent", () => (network.request_count += 1));
  cdp.on(
    "Network.loadingFinished",
    ({ encodedDataLength }) =>
      (network.encoded_bytes += encodedDataLength ?? 0),
  );
  cdp.on(
    "Network.webSocketFrameReceived",
    ({ response }) =>
      (network.websocket_received_bytes += Buffer.byteLength(
        response.payloadData ?? "",
      )),
  );
  cdp.on(
    "Network.webSocketFrameSent",
    ({ response }) =>
      (network.websocket_sent_bytes += Buffer.byteLength(
        response.payloadData ?? "",
      )),
  );
  return { cdp, network };
}

async function performanceMetrics(cdp) {
  const cdpMetrics = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    cdpMetrics.metrics.map(({ name, value }) => [name, value]),
  );
}

async function browserMetrics(page, cdp, baseline) {
  const metrics = await performanceMetrics(cdp);
  const browser = await page.evaluate(() => {
    const resources = performance.getEntriesByType("resource");
    const marks = performance
      .getEntriesByType("mark")
      .filter(({ name }) => name.startsWith("cocalc-ultralite:"))
      .map(({ name, startTime }) => ({
        name,
        start_ms: Math.round(startTime),
      }));
    const groups = {};
    for (const entry of resources) {
      const url = new URL(entry.name, location.href);
      const group = url.pathname.startsWith("/static/")
        ? "static"
        : url.pathname.startsWith("/api/")
          ? "control_plane"
          : url.origin !== location.origin
            ? "project_data"
            : "other";
      const current = groups[group] ?? {
        count: 0,
        decoded_body_size: 0,
        duration_ms: 0,
        transfer_size: 0,
      };
      current.count += 1;
      current.decoded_body_size += entry.decodedBodySize || 0;
      current.duration_ms += entry.duration || 0;
      current.transfer_size += entry.transferSize || 0;
      groups[group] = current;
    }
    const phases = {};
    for (const mark of marks) {
      const match = mark.name.match(
        /^cocalc-ultralite:([^:]+):backend-(start|end)$/,
      );
      if (!match) continue;
      phases[match[1]] ??= {};
      phases[match[1]][match[2]] = mark.start_ms;
    }
    for (const value of Object.values(phases)) {
      if (value.start != null && value.end != null) {
        value.duration_ms = Math.max(0, value.end - value.start);
      }
    }
    return {
      marks,
      backend_phases: phases,
      resource_groups: groups,
      resource_count: resources.length,
      transfer_size: resources.reduce(
        (sum, entry) => sum + (entry.transferSize || 0),
        0,
      ),
      decoded_body_size: resources.reduce(
        (sum, entry) => sum + (entry.decodedBodySize || 0),
        0,
      ),
    };
  });
  return {
    ...browser,
    js_heap_used_bytes: metrics.JSHeapUsedSize,
    script_duration_ms: Math.round(
      ((metrics.ScriptDuration ?? 0) - (baseline.ScriptDuration ?? 0)) * 1_000,
    ),
    task_duration_ms: Math.round(
      ((metrics.TaskDuration ?? 0) - (baseline.TaskDuration ?? 0)) * 1_000,
    ),
  };
}

async function measureScenario({
  browser,
  baseUrl,
  cpuRate,
  output,
  scenario,
  storageState,
  viewport,
  warm,
}) {
  const context = await browser.newContext({
    storageState,
    viewport: VIEWPORTS[viewport],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(`${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const { cdp, network } = await configure(page, {
    cpuRate,
    disableCache: !warm,
  });
  const url = ultraliteUrl(baseUrl, scenario.hash);
  if (warm) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector(scenario.selector, { timeout: 60_000 });
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
    network.encoded_bytes = 0;
    network.request_count = 0;
    network.websocket_received_bytes = 0;
    network.websocket_sent_bytes = 0;
    await page.evaluate(() => {
      performance.clearMarks();
      performance.clearResourceTimings();
    });
  }
  const baseline = await performanceMetrics(cdp);
  const started = performance.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector(scenario.selector, { timeout: 60_000 });
  const usefulMs = Math.round(performance.now() - started);
  await page.screenshot({
    path: resolve(
      output,
      `${scenario.name}-${viewport}-${warm ? "warm" : "cold"}.png`,
    ),
    fullPage: true,
  });
  const result = {
    scenario: scenario.name,
    cache: warm ? "warm" : "cold",
    viewport,
    cpu_rate: cpuRate,
    network: NETWORK,
    useful_ms: usefulMs,
    slo_ms: Math.round(scenario.sloMs * (cpuRate > 1 ? 1.6 : 1)),
    passed: usefulMs <= scenario.sloMs * (cpuRate > 1 ? 1.6 : 1),
    network_observed: network,
    browser: await browserMetrics(page, cdp, baseline),
    errors,
  };
  await context.close();
  return result;
}

function standardScenarioUrl(base, scenario, args) {
  const url = new URL(base);
  if (scenario.name === "projects") {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/projects`;
    return url.toString();
  }
  const projectId = required(args, "project-id");
  const path =
    scenario.name === "files"
      ? ""
      : `${args[scenario.name === "notebook" ? "notebook" : "file"] ?? ""}`
          .replace(/^\/home\/user\/?/, "")
          .split("/")
          .filter(Boolean)
          .map(encodeURIComponent)
          .join("/");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/projects/${projectId}/files/${path}`;
  return url.toString();
}

async function captureStandardReferences({
  args,
  browser,
  output,
  scenarios: rows,
  storageState,
  viewport,
}) {
  if (!args["standard-url"]) return;
  const context = await browser.newContext({
    storageState,
    viewport: VIEWPORTS[viewport],
  });
  const page = await context.newPage();
  for (const scenario of rows.filter(({ name }) => name !== "chat")) {
    await page.goto(standardScenarioUrl(args["standard-url"], scenario, args), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => {});
    await page.screenshot({
      path: resolve(output, `standard-${scenario.name}-${viewport}.png`),
      fullPage: true,
    });
  }
  await context.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: pnpm measure:ultralite -- --url <origin> [options]

Options:
  --storage-state <file>  Playwright state containing the signed-in cookie
  --project-id <uuid>     Also measure the project home directory
  --file <path>           Also measure a text/code file
  --notebook <path>       Also measure a read-only notebook
  --chat-path <path>      Existing chat path (requires --thread-id)
  --thread-id <id>        Existing Codex thread
  --viewport desktop|tablet|narrow|small
  --cpu 1|4
  --standard-url <origin> Capture matching full-CoCalc reference screenshots
  --output <directory>
  --assert-slo            Exit nonzero when a measured SLO fails
  --chromium <path>       Chromium executable (auto-detects common system paths)
  --headed                Show Chromium`);
    return;
  }
  const baseUrl = required(args, "url");
  const output = resolve(
    `${args.output ?? `/tmp/cocalc-ultralite-measurements-${new Date().toISOString().replace(/[:.]/g, "-")}`}`,
  );
  const viewport = Object.hasOwn(VIEWPORTS, args.viewport)
    ? args.viewport
    : "desktop";
  const cpuRate = Number(args.cpu ?? 1) === 4 ? 4 : 1;
  const storageState = args["storage-state"]
    ? resolve(`${args["storage-state"]}`)
    : undefined;
  const rows = scenarios(args);
  await mkdir(output, { recursive: true });
  const systemChromium = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].find(existsSync);
  const executablePath = args.chromium
    ? resolve(`${args.chromium}`)
    : systemChromium;
  const browser = await chromium.launch({
    executablePath,
    headless: args.headed !== true,
  });
  const results = [];
  try {
    for (const scenario of rows) {
      results.push(
        await measureScenario({
          browser,
          baseUrl,
          cpuRate,
          output,
          scenario,
          storageState,
          viewport,
          warm: false,
        }),
      );
      results.push(
        await measureScenario({
          browser,
          baseUrl,
          cpuRate,
          output,
          scenario,
          storageState,
          viewport,
          warm: true,
        }),
      );
    }
    await captureStandardReferences({
      args,
      browser,
      output,
      scenarios: rows,
      storageState,
      viewport,
    });
  } finally {
    await browser.close();
  }
  const report = {
    generated_at: new Date().toISOString(),
    base_url: baseUrl,
    profile: {
      network: NETWORK,
      cpu_rate: cpuRate,
      viewport: VIEWPORTS[viewport],
    },
    results,
  };
  const reportPath = resolve(output, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const result of results) {
    console.log(
      `${result.scenario} ${result.cache}: ${result.useful_ms}ms / ${result.slo_ms}ms ${result.passed ? "PASS" : "FAIL"}`,
    );
  }
  console.log(`report: ${reportPath} (${basename(output)})`);
  if (args["assert-slo"] && results.some(({ passed }) => !passed)) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : `${error}`);
  process.exitCode = 1;
});
