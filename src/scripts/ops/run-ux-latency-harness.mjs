#!/usr/bin/env node
/*
 * Drive retention-critical CoCalc workflows through a signed-in Chromium tab.
 * This is intentionally a thin plan generator around `cocalc browser harness`.
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(scriptDir, "../..");
const cli = resolve(srcRoot, "packages/cli/dist/bin/cocalc.js");

const NETWORK_PROFILES = {
  native: undefined,
  "fast-4g": {
    latency: 20,
    downloadThroughput: (20 * 1_000_000) / 8,
    uploadThroughput: (8 * 1_000_000) / 8,
    connectionType: "wifi",
  },
  "5mbps": {
    latency: 50,
    downloadThroughput: (5 * 1_000_000) / 8,
    uploadThroughput: (2 * 1_000_000) / 8,
    connectionType: "wifi",
  },
  "10mbps": {
    latency: 50,
    downloadThroughput: (10 * 1_000_000) / 8,
    uploadThroughput: (4 * 1_000_000) / 8,
    connectionType: "wifi",
  },
  "10mbps-high-latency": {
    latency: 300,
    downloadThroughput: (10 * 1_000_000) / 8,
    uploadThroughput: (4 * 1_000_000) / 8,
    connectionType: "wifi",
  },
  "slow-4g": {
    latency: 150,
    downloadThroughput: (1.6 * 1_000_000) / 8,
    uploadThroughput: (750 * 1_000) / 8,
    connectionType: "cellular4g",
  },
  "1mbps": {
    latency: 150,
    downloadThroughput: 1_000_000 / 8,
    uploadThroughput: 500_000 / 8,
    connectionType: "cellular4g",
  },
  "2mbps": {
    latency: 100,
    downloadThroughput: 2_000_000 / 8,
    uploadThroughput: 1_000_000 / 8,
    connectionType: "cellular4g",
  },
  "3g": {
    latency: 200,
    downloadThroughput: 750_000 / 8,
    uploadThroughput: 250_000 / 8,
    connectionType: "cellular3g",
  },
};

const STARTUP_TARGETS = new Set([
  "projects",
  "project",
  "file",
  "jupyter",
  "terminal",
  "account",
  "docs",
  "admin",
]);

function usage(exitCode = 0) {
  console.log(`Usage:
  node src/scripts/ops/run-ux-latency-harness.mjs \\
    --api https://staging.cocalc.ai --profile staging \\
    --project <uuid> [--browser <id>] [--iterations 3] [--include-codex]

Direct Chromium qualification options:
  --network <native|fast-4g|5mbps|10mbps|10mbps-high-latency|slow-4g|2mbps|1mbps|3g>
  --cpu-throttle <1-20>  --cache <warm|cold>  --mobile
  --startup-only [--startup-target <projects|project|file|jupyter|terminal|account|docs|admin>]
  --test-account <account-id-or-email>

For an isolated test account, pass --test-account with --direct to issue a new
one-time impersonation grant from the selected fresh-auth CLI profile. You may
instead set COCALC_UX_HARNESS_SIGN_IN_URL explicitly. Both paths launch a clean
Chromium process without exposing the operator's account cookie or discovering
browser sessions.

The target browser must already be signed in and connected. The harness creates
small fixtures under /home/user/cocalc-ux-harness, drives a hard refresh,
directory listing, text file, Jupyter, LaTeX, upload, terminal, and optionally a
real Codex turn, then writes the ordinary browser-harness report.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const options = {
    iterations: 1,
    includeCodex: false,
    reportDir: undefined,
    direct: false,
    chromium: "/usr/local/bin/chromium-browser",
    network: "native",
    cpuThrottle: 1,
    cache: "warm",
    mobile: false,
    startupOnly: false,
    startupTarget: "project",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--api") options.api = value();
    else if (arg === "--profile") options.profile = value();
    else if (arg === "--project") options.project = value();
    else if (arg === "--browser") options.browser = value();
    else if (arg === "--iterations") options.iterations = Number(value());
    else if (arg === "--report-dir") options.reportDir = value();
    else if (arg === "--include-codex") options.includeCodex = true;
    else if (arg === "--direct") options.direct = true;
    else if (arg === "--chromium") options.chromium = value();
    else if (arg === "--network") options.network = value();
    else if (arg === "--cpu-throttle") options.cpuThrottle = Number(value());
    else if (arg === "--cache") options.cache = value();
    else if (arg === "--mobile") options.mobile = true;
    else if (arg === "--startup-only") options.startupOnly = true;
    else if (arg === "--startup-target") options.startupTarget = value();
    else if (arg === "--test-account") options.testAccount = value();
    else if (arg === "--help" || arg === "-h") usage();
    else throw Error(`unknown option '${arg}'`);
  }
  options.api ??= process.env.COCALC_SITE_URL;
  options.project ??= process.env.COCALC_PROJECT_ID;
  options.browser ??= process.env.COCALC_BROWSER_ID;
  options.signInUrl = process.env.COCALC_UX_HARNESS_SIGN_IN_URL;
  if (!options.api) throw Error("--api or COCALC_SITE_URL is required");
  if (!options.project)
    throw Error("--project or COCALC_PROJECT_ID is required");
  if (
    !Number.isInteger(options.iterations) ||
    options.iterations < 1 ||
    options.iterations > 100
  ) {
    throw Error("--iterations must be an integer from 1 through 100");
  }
  if (options.direct && !options.signInUrl && !options.testAccount) {
    throw Error(
      "--test-account or COCALC_UX_HARNESS_SIGN_IN_URL is required with --direct",
    );
  }
  if (!(options.network in NETWORK_PROFILES)) {
    throw Error(`unknown --network profile '${options.network}'`);
  }
  if (
    !Number.isFinite(options.cpuThrottle) ||
    options.cpuThrottle < 1 ||
    options.cpuThrottle > 20
  ) {
    throw Error("--cpu-throttle must be a number from 1 through 20");
  }
  if (!new Set(["warm", "cold"]).has(options.cache)) {
    throw Error("--cache must be warm or cold");
  }
  if (!STARTUP_TARGETS.has(options.startupTarget)) {
    throw Error(`unknown --startup-target '${options.startupTarget}'`);
  }
  if (
    !options.direct &&
    (options.network !== "native" ||
      options.cpuThrottle !== 1 ||
      options.cache !== "warm" ||
      options.mobile ||
      options.startupOnly)
  ) {
    throw Error(
      "network, CPU, cache, mobile, and startup-only controls require --direct",
    );
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const origin = new URL(options.api).origin;
const runId = `ux-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const reportDir = resolve(
  options.reportDir ?? `.cocalc-browser-harness/${runId}`,
);
const fixtureDir = mkdtempSync(join(tmpdir(), "cocalc-ux-harness-"));
const remoteRootName = options.direct
  ? `cocalc-ux-harness-${runId.slice(-8)}`
  : "cocalc-ux-harness";
const remoteRoot = `/home/user/${remoteRootName}`;

const globalArgs = [];
globalArgs.push("--no-daemon", "--disable-env-auth-defaults");
if (options.profile) globalArgs.push("--profile", options.profile);
globalArgs.push("--api", options.api);

function run(args, { capture = false } = {}) {
  const env = { ...process.env };
  for (const name of [
    "COCALC_API_KEY",
    "COCALC_API_URL",
    "COCALC_BEARER_TOKEN",
    "COCALC_HUB_PASSWORD",
    "COCALC_PROJECT_ID",
    "COCALC_SECRETS",
    "COCALC_SECRET_TOKEN",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [cli, ...globalArgs, ...args], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env,
  });
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw Error(`cocalc ${args.join(" ")} failed${detail}`);
  }
  return capture ? result.stdout : "";
}

function issueDirectSignInUrl() {
  if (options.signInUrl) return options.signInUrl;
  const output = JSON.parse(
    run(
      [
        "--json",
        "admin",
        "user",
        "issue-impersonation-link",
        options.testAccount,
      ],
      { capture: true },
    ),
  );
  const url = `${output?.data?.url ?? ""}`.trim();
  if (!url) {
    throw Error("impersonation grant response did not contain a sign-in URL");
  }
  return url;
}

function projectFileUrl(path = "") {
  const relative = `${path}`
    .replace(/^\/home\/user\/?/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${origin}/projects/${options.project}/files/home/user/${relative}`;
}

function remoteUrl(path = "") {
  return projectFileUrl(`${remoteRoot}/${path}`);
}

function waitForText(name, includes, timeout_ms = 45_000) {
  return {
    name,
    action: { name: "wait_for_text", includes, timeout_ms, poll_ms: 100 },
  };
}

function navigate(name, path) {
  return {
    name,
    action: { name: "navigate", url: remoteUrl(path), wait_for_url_ms: 20_000 },
  };
}

function navigateUrl(name, url) {
  return {
    name,
    action: { name: "navigate", url, wait_for_url_ms: 20_000 },
  };
}

function navigateProjectHome(name) {
  return {
    name,
    action: {
      name: "navigate",
      url: projectFileUrl(""),
      wait_for_url_ms: 20_000,
    },
  };
}

function enterHarnessDirectorySteps(prefix) {
  return [
    navigateProjectHome(`${prefix}: open project home`),
    waitForText(`${prefix}: harness folder visible`, remoteRootName),
    {
      name: `${prefix}: enter harness folder`,
      action: {
        name: "click",
        selector: `span[title='${remoteRootName}']`,
        timeout_ms: 30_000,
      },
    },
    waitForText(`${prefix}: directory listing`, "visible.md"),
  ];
}

function startupQualificationSteps() {
  const reload = {
    name: `hard refresh ${options.startupTarget} surface`,
    action: { name: "reload", hard: true },
    pause_ms: 2_500,
    retries: 2,
  };
  switch (options.startupTarget) {
    case "projects":
      return [
        navigateUrl("load Projects before hard refresh", `${origin}/projects`),
        reload,
        waitForText("Projects useful surface", "Create"),
      ];
    case "project":
      return [
        navigateProjectHome("load project before hard refresh"),
        reload,
        ...enterHarnessDirectorySteps("application and project ready"),
      ];
    case "file":
      return [
        navigate("load text file before hard refresh", "visible.md"),
        reload,
        waitForText("text useful surface", `Visible marker ${runId}`),
      ];
    case "jupyter":
      return [
        navigate("load Jupyter before hard refresh", "notebook.ipynb"),
        reload,
        {
          name: "Jupyter useful surface",
          action: {
            name: "wait_for_selector",
            selector: ".CodeMirror",
            timeout_ms: 90_000,
          },
        },
      ];
    case "terminal":
      return [
        navigate("load terminal before hard refresh", "terminal.term"),
        reload,
        {
          name: "terminal useful surface",
          action: {
            name: "wait_for_selector",
            selector: ".xterm-helper-textarea",
            state: "attached",
            timeout_ms: 90_000,
          },
        },
      ];
    case "account":
      return [
        navigateUrl("load Account before hard refresh", `${origin}/settings`),
        reload,
        waitForText("Account useful surface", "Settings"),
      ];
    case "docs":
      return [
        navigateUrl("load Docs before hard refresh", `${origin}/docs`),
        reload,
        {
          name: "Docs useful surface",
          action: {
            name: "wait_for_selector",
            selector: "[data-testid='docs-markdown']",
            timeout_ms: 90_000,
          },
        },
      ];
    case "admin":
      return [
        navigateUrl("load Admin before hard refresh", `${origin}/admin`),
        reload,
        waitForText("Admin useful surface", "Administration", 90_000),
      ];
  }
  throw Error(`unsupported startup target '${options.startupTarget}'`);
}

function createFixtures() {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "visible.md"),
    `# UX latency harness\n\nVisible marker ${runId}\n`,
  );
  writeFileSync(
    join(fixtureDir, "notebook.ipynb"),
    JSON.stringify({
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          id: "ux-harness-cell",
          metadata: {},
          outputs: [],
          source: [`print(\"JUPYTER_${runId}\")`],
        },
      ],
      metadata: {
        kernelspec: {
          display_name: "Python 3",
          language: "python",
          name: "python3",
        },
        language_info: { name: "python", version: "3" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    }),
  );
  writeFileSync(
    join(fixtureDir, "document.tex"),
    `\\documentclass{article}\n\\begin{document}\nLaTeX ${runId}\n\\end{document}\n`,
  );
  writeFileSync(join(fixtureDir, "terminal.term"), "");
  if (options.direct) return;
  run([
    "project",
    "exec",
    "-w",
    options.project,
    "--",
    "mkdir",
    "-p",
    remoteRoot,
  ]);
  for (const name of [
    "visible.md",
    "notebook.ipynb",
    "document.tex",
    "terminal.term",
  ]) {
    const content = readFileSync(join(fixtureDir, name)).toString("base64");
    run([
      "project",
      "exec",
      "-w",
      options.project,
      "--",
      "bash",
      "-lc",
      `printf '%s' '${content}' | base64 --decode > '${remoteRoot}/${name}'`,
    ]);
  }
}

function iterationSteps(iteration) {
  const prefix = `iteration ${iteration}`;
  const uploadName = `uploaded-${runId}-${iteration}.txt`;
  const uploadContent = Buffer.from(
    `Upload marker ${runId} iteration ${iteration}\n`,
  ).toString("base64");
  const steps = [
    ...enterHarnessDirectorySteps(prefix),
    navigate(`${prefix}: open text file`, "visible.md"),
    waitForText(`${prefix}: text visible`, `Visible marker ${runId}`),
    navigate(`${prefix}: open Jupyter`, "notebook.ipynb"),
    {
      name: `${prefix}: Jupyter editor ready`,
      action: {
        name: "wait_for_selector",
        selector: ".CodeMirror",
        timeout_ms: 60_000,
      },
    },
    {
      name: `${prefix}: focus Jupyter cell`,
      action: { name: "click", selector: ".CodeMirror", timeout_ms: 30_000 },
    },
    {
      name: `${prefix}: run Jupyter cell`,
      action: { name: "press", key: "Enter", shift: true, timeout_ms: 30_000 },
    },
    waitForText(`${prefix}: Jupyter output`, `JUPYTER_${runId}`, 90_000),
    navigate(`${prefix}: open LaTeX`, "document.tex"),
    {
      name: `${prefix}: LaTeX build ready`,
      action: {
        name: "wait_for_selector",
        selector: "[data-testid='latex-build']",
        timeout_ms: 60_000,
      },
    },
    {
      name: `${prefix}: build LaTeX`,
      action: { name: "click", selector: "[data-testid='latex-build']" },
    },
    { name: `${prefix}: allow LaTeX completion`, sleep_ms: 5_000 },
    ...enterHarnessDirectorySteps(`${prefix}: return for upload`),
    {
      name: `${prefix}: upload input ready`,
      action: {
        name: "wait_for_selector",
        selector: "input[type='file']",
        state: "attached",
        timeout_ms: 30_000,
      },
    },
    {
      name: `${prefix}: upload fixture`,
      action: {
        name: "upload_file",
        selector: "input[type='file']",
        filename: uploadName,
        content_base64: uploadContent,
        mime_type: "text/plain",
      },
    },
    waitForText(`${prefix}: upload visible`, uploadName, 60_000),
    navigate(`${prefix}: open terminal`, "terminal.term"),
    {
      name: `${prefix}: terminal ready`,
      action: {
        name: "wait_for_selector",
        selector: ".xterm-helper-textarea",
        state: "attached",
        timeout_ms: 90_000,
      },
    },
  ];
  if (options.includeCodex) {
    const prompt = `Reply with the words UX, HARNESS, and READY joined by underscores, followed by a space and the number ${iteration}.`;
    steps.push(
      navigate(`${prefix}: open Codex chat`, `codex-${runId}.chat`),
      {
        name: `${prefix}: Codex composer ready`,
        action: {
          name: "wait_for_selector",
          selector: "[data-testid='chat-composer-input']",
          timeout_ms: 60_000,
        },
      },
      ...(options.direct
        ? [
            {
              name: `${prefix}: send Codex prompt`,
              action: {
                name: "send_codex_prompt",
                prompt,
                timeout_ms: 60_000,
              },
            },
          ]
        : [
            {
              name: `${prefix}: enter Codex prompt`,
              action: {
                name: "type",
                selector:
                  "[data-testid='chat-composer-input'] [data-slate-editor='true']",
                text: prompt,
              },
            },
            {
              name: `${prefix}: send Codex prompt`,
              action: {
                name: "click",
                selector: "[data-testid='chat-composer-send']",
              },
            },
          ]),
      waitForText(
        `${prefix}: Codex first response`,
        `UX_HARNESS_READY ${iteration}`,
        180_000,
      ),
    );
  }
  return steps;
}

async function runDirectHarness(plan) {
  const require = createRequire(import.meta.url);
  const { chromium, devices } = require(
    resolve(srcRoot, "packages/cli/node_modules/playwright-core"),
  );
  const mobileDevice = devices["iPhone 15 Pro"];
  const browser = await chromium.launch({
    executablePath: options.chromium,
    headless: true,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    ...(options.mobile
      ? mobileDevice
      : {
          viewport: { width: 1440, height: 1000 },
          deviceScaleFactor: 1,
          hasTouch: false,
          isMobile: false,
        }),
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const browserLogs = [];
  page.on("console", (message) => {
    browserLogs.push({
      at: new Date().toISOString(),
      level: message.type(),
      message: message.text(),
    });
    if (browserLogs.length > 500) browserLogs.shift();
  });
  page.on("pageerror", (error) => {
    browserLogs.push({
      at: new Date().toISOString(),
      level: "pageerror",
      message: `${error}`,
    });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    browserLogs.push({
      at: new Date().toISOString(),
      level: "http",
      message: `${response.status()} ${response.request().method()} ${response.url()}`,
    });
    if (browserLogs.length > 500) browserLogs.shift();
  });

  const steps = [];
  const startedAt = new Date().toISOString();

  async function applyQualificationProfile() {
    await cdp.send("Network.enable");
    const network = NETWORK_PROFILES[options.network];
    if (network != null) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        ...network,
      });
    }
    await cdp.send("Emulation.setCPUThrottlingRate", {
      rate: options.cpuThrottle,
    });
  }

  async function createDirectFixtures() {
    await page.goto(projectFileUrl(`ux-harness-setup-${runId}.term`), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const terminal = page.locator(".xterm-helper-textarea").first();
    await terminal.waitFor({ state: "attached", timeout: 90_000 });
    await terminal.click();
    await page.waitForTimeout(1_000);
    const commands = [`mkdir -p '${remoteRoot}'`];
    for (const name of [
      "visible.md",
      "notebook.ipynb",
      "document.tex",
      "terminal.term",
    ]) {
      const content = readFileSync(join(fixtureDir, name)).toString("base64");
      commands.push(
        `printf '%s' '${content}' | base64 --decode > '${remoteRoot}/${name}'`,
      );
    }
    const readyMarker = `UX_FIXTURES_READY_${runId}`;
    commands.push(
      `test -f '${remoteRoot}/visible.md' && printf '\\n%s%s\\n' 'UX_FIXTURES_' 'READY_${runId}'`,
    );
    for (const command of commands) {
      await page.keyboard.insertText(command);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(500);
    }
    await page.waitForFunction(
      (text) => document.body?.innerText?.includes(text),
      readyMarker,
      { timeout: 30_000, polling: 100 },
    );
  }

  async function cleanupDirectFixtures(cleanupPage) {
    const setupPath = `/home/user/ux-harness-setup-${runId}.term`;
    const cleanupPath = `/home/user/ux-harness-cleanup-${runId}.term`;
    await cleanupPage.goto(projectFileUrl(cleanupPath), {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const terminal = cleanupPage.locator(".xterm-helper-textarea").first();
    await terminal.waitFor({ state: "attached", timeout: 90_000 });
    await terminal.click();
    await cleanupPage.waitForTimeout(1_000);
    const marker = `UX_FIXTURES_REMOVED_${runId}`;
    await cleanupPage.keyboard.insertText(
      `rm -rf '${remoteRoot}'; printf '\\n%s\\n' '${marker}'; (sleep 2; rm -f '${setupPath}' '${cleanupPath}') >/dev/null 2>&1 &`,
    );
    await cleanupPage.keyboard.press("Enter");
    await cleanupPage.waitForFunction(
      (text) => document.body?.innerText?.includes(text),
      marker,
      { timeout: 30_000, polling: 100 },
    );
  }

  async function executeStep(step) {
    if (step.sleep_ms != null) {
      await page.waitForTimeout(step.sleep_ms);
      return;
    }
    const action = step.action ?? {};
    const timeout = action.timeout_ms ?? plan.default_timeout_ms;
    switch (action.name) {
      case "navigate":
        await page.goto(action.url, {
          waitUntil: "domcontentloaded",
          timeout: action.wait_for_url_ms ?? timeout,
        });
        break;
      case "reload":
        if (options.cache === "cold") {
          await cdp.send("Network.clearBrowserCache");
        }
        await page.reload({ waitUntil: "domcontentloaded", timeout });
        break;
      case "wait_for_text":
        await page
          .locator("body :visible", { hasText: action.includes })
          .last()
          .waitFor({ state: "visible", timeout });
        break;
      case "wait_for_selector":
        await page
          .locator(action.selector)
          .first()
          .waitFor({
            state: action.state ?? "visible",
            timeout,
          });
        break;
      case "click":
        await page.locator(action.selector).first().click({ timeout });
        break;
      case "press": {
        const modifiers = [
          action.control ? "Control" : undefined,
          action.alt ? "Alt" : undefined,
          action.shift ? "Shift" : undefined,
          action.meta ? "Meta" : undefined,
        ].filter(Boolean);
        const key = [...modifiers, action.key].join("+");
        await page.keyboard.press(key);
        break;
      }
      case "type": {
        const target = page.locator(action.selector).first();
        await target.click({ timeout });
        await target.fill(action.text, { timeout });
        break;
      }
      case "send_codex_prompt": {
        const connectAi = page.getByText(
          "To use AI in CoCalc, connect a ChatGPT plan or OpenAI API key.",
          { exact: true },
        );
        if (await connectAi.isVisible().catch(() => false)) {
          throw Error(
            "the harness account must connect a ChatGPT plan or OpenAI API key before --include-codex can run",
          );
        }
        const createChat = page.getByRole("button", {
          name: "Create chat",
          exact: true,
        });
        if (await createChat.isVisible().catch(() => false)) {
          await createChat.click({ timeout });
          await createChat.waitFor({ state: "hidden", timeout });
        }
        const input = page
          .locator(
            "[data-testid='chat-composer-input'] [data-slate-editor='true']",
          )
          .first();
        await input.fill(action.prompt, { timeout });
        await page
          .locator("[data-testid='chat-composer-send']")
          .first()
          .click({ timeout });
        break;
      }
      case "upload_file":
        await page
          .locator(action.selector)
          .first()
          .setInputFiles({
            name: action.filename,
            mimeType: action.mime_type ?? "application/octet-stream",
            buffer: Buffer.from(action.content_base64, "base64"),
          });
        break;
      default:
        throw Error(`unsupported direct action '${action.name}'`);
    }
  }

  async function runStep(step) {
    const maxAttempts = 1 + (step.retries ?? plan.default_retries ?? 0);
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      try {
        await executeStep(step);
        if (step.pause_ms ?? plan.default_pause_ms) {
          await page.waitForTimeout(step.pause_ms ?? plan.default_pause_ms);
        }
        steps.push({
          name: step.name,
          status: "passed",
          attempt,
          duration_ms: Date.now() - started,
          url: page.url(),
        });
        return;
      } catch (err) {
        lastError = err;
        steps.push({
          name: step.name,
          status: "failed",
          attempt,
          duration_ms: Date.now() - started,
          error: `${err}`,
          url: page.url(),
        });
        if (attempt < maxAttempts && plan.default_recovery === "reload") {
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        }
      }
    }
    throw lastError;
  }

  let failure;
  try {
    const signInUrl = issueDirectSignInUrl();
    await page.goto(signInUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const continueImpersonation = page.getByText("Continue impersonation", {
      exact: true,
    });
    if (await continueImpersonation.isVisible().catch(() => false)) {
      await continueImpersonation.click();
    }
    await page.waitForURL(
      (url) => !url.pathname.startsWith("/auth/impersonate"),
      { timeout: 60_000 },
    );
    await createDirectFixtures();
    await applyQualificationProfile();
    for (const step of [
      ...(plan.before_all ?? []),
      ...(plan.steps ?? []),
      ...(plan.after_all ?? []),
    ]) {
      await runStep(step);
    }
  } catch (err) {
    failure = `${err}`;
    mkdirSync(reportDir, { recursive: true });
    await page
      .screenshot({ path: join(reportDir, "failure.png"), fullPage: true })
      .catch(() => {});
  } finally {
    // Stop every measured sync document before deleting its backing fixture.
    // Otherwise a retained watcher can race the next run's recreation of the
    // same path and make the harness observe stale collaborative history.
    await page.close().catch(() => {});
    let cleanupPage;
    try {
      cleanupPage = await context.newPage();
      await cleanupDirectFixtures(cleanupPage);
    } catch (err) {
      failure ??= `fixture cleanup failed: ${err}`;
      browserLogs.push({
        at: new Date().toISOString(),
        level: "cleanup-error",
        message: `${err}`,
      });
    } finally {
      await cleanupPage?.close().catch(() => {});
    }
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, "report.json"),
      JSON.stringify(
        {
          name: plan.name,
          mode: "direct-playwright",
          started_at: startedAt,
          finished_at: new Date().toISOString(),
          status: failure ? "failed" : "passed",
          failure,
          project_id: options.project,
          qualification_profile: {
            network: options.network,
            cpu_throttle: options.cpuThrottle,
            cache: options.cache,
            mobile: options.mobile,
            mobile_device: options.mobile ? "iPhone 15 Pro" : undefined,
            startup_only: options.startupOnly,
            startup_target: options.startupTarget,
          },
          steps,
          browser_logs: browserLogs,
        },
        null,
        2,
      ),
    );
    await context.close();
    await browser.close();
  }
  if (failure) throw Error(failure);
}

try {
  createFixtures();
  const plan = {
    name: `retention UX latency ${runId}`,
    default_retries: 1,
    default_timeout_ms: 60_000,
    default_recovery: "reload",
    default_pause_ms: 150,
    max_failures: 1,
    capture: {
      screenshot_on_fail: true,
      logs_on_fail: 160,
      network_on_fail: 160,
    },
    before_all: startupQualificationSteps(),
    steps: options.startupOnly
      ? []
      : Array.from({ length: options.iterations }, (_, index) =>
          iterationSteps(index + 1),
        ).flat(),
    after_all: enterHarnessDirectorySteps("finish"),
  };
  const planPath = join(fixtureDir, "plan.json");
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const harnessArgs = [
    "browser",
    "harness",
    "run",
    "--plan",
    planPath,
    "--project-id",
    options.project,
    "--session-project-id",
    options.project,
    "--active-only",
    "--report-dir",
    reportDir,
    "--pin-target",
  ];
  if (options.browser) harnessArgs.push("--browser", options.browser);
  console.log(`ux_harness_run_id=${runId}`);
  console.log(`ux_harness_started_at=${new Date().toISOString()}`);
  console.log(`ux_harness_report_dir=${reportDir}`);
  if (options.direct) {
    await runDirectHarness(plan);
  } else {
    run(harnessArgs);
  }
  console.log(`ux_harness_finished_at=${new Date().toISOString()}`);
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}
