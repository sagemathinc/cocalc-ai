#!/usr/bin/env node

import { spawn } from "child_process";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import http from "http";
import { join } from "path";
import { tmpdir } from "os";

const DEFAULT_BASE_URL = "https://blaec.cocalc.ai";
const ARTIFACT_PREFIX = "cocalc-public-qa-";
const DEFAULT_WAIT_MS = 1800;
const DEFAULT_TIMEOUT_MS = 20000;

const VIEWPORTS = {
  desktop: { width: 1440, height: 1100, mobile: false },
  tablet: { width: 820, height: 1180, mobile: false },
  mobile: { width: 390, height: 1000, mobile: true },
};

const ROUTE_GROUPS = {
  "feature-index": ["/features"],
  "feature-core": [
    "/features",
    "/features/ai",
    "/features/jupyter-notebook",
    "/features/terminal",
    "/features/linux",
    "/features/teaching",
  ],
  "feature-details": [
    "/features/ai",
    "/features/jupyter-notebook",
    "/features/terminal",
    "/features/linux",
    "/features/teaching",
    "/features/python",
    "/features/latex-editor",
    "/features/whiteboard",
    "/features/slides",
    "/features/api",
    "/features/sage",
    "/features/r-statistical-software",
    "/features/julia",
    "/features/octave",
  ],
  guides: ["/guides"],
  "conversion-spine": [
    "/",
    "/products",
    "/pricing",
    "/features/compare",
    "/support",
    "/support/new",
  ],
  "product-details": [
    "/products/cocalc-plus",
    "/products/cocalc-star",
    "/products/cocalc-launchpad",
    "/products/cocalc-rocket",
  ],
};

const GLOBAL_FORBIDDEN_TEXT = [
  "public-site cohesion audit",
  "agent operating",
  "proof packet",
  "evidence register",
  "pitch docs",
  "competitor comparison",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CoCalc-AI",
];

const ROUTE_RULES = {
  "/": {
    requireText: [
      "AI-NATIVE TECHNICAL WORKSPACE",
      "Shared projects for research, teaching, and technical teams",
      "Choose the operating model that fits your team.",
    ],
    requireLinks: [
      { text: "Start on CoCalc.ai", hrefIncludes: "/auth/sign-up" },
      { text: "Compare operating models", hrefIncludes: "/products" },
      { text: "Browse feature workflows", hrefIncludes: "/features" },
    ],
  },
  "/products": {
    requireText: [
      "Ways to Run CoCalc",
      "Choose how CoCalc should run for your team.",
      "CoCalc.ai",
      "CoCalc Plus",
      "CoCalc Star",
      "CoCalc Launchpad",
      "CoCalc Rocket",
    ],
    requireLinks: [
      { text: "Compare CoCalc fit", hrefIncludes: "/features/compare" },
      { text: "Pricing and licensing", hrefIncludes: "/pricing" },
      { text: "View CoCalc Plus", hrefIncludes: "/products/cocalc-plus" },
      { text: "View CoCalc Star", hrefIncludes: "/products/cocalc-star" },
      {
        text: "View CoCalc Launchpad",
        hrefIncludes: "/products/cocalc-launchpad",
      },
      { text: "View CoCalc Rocket", hrefIncludes: "/products/cocalc-rocket" },
    ],
  },
  "/pricing": {
    requireText: [
      "CoCalc.ai Pricing and Licensing",
      "Hosted CoCalc.ai plans",
      "Site licensing",
      "Dedicated project hosts",
    ],
    requireLinks: [
      { text: "Compare operating models", hrefIncludes: "/products" },
      {
        text: "Talk with CoCalc about site licensing",
        hrefIncludes: "context=pricing-site-license",
      },
      { text: "Review trust materials", hrefIncludes: "/policies/trust" },
    ],
  },
  "/features/compare": {
    requireText: [
      "Compare CoCalc",
      "When is CoCalc the right fit?",
      "The practical split.",
      "Where to go next.",
    ],
    requireLinks: [
      { text: "Compare operating models", hrefIncludes: "/products" },
      { text: "Pricing and licensing", hrefIncludes: "/pricing" },
      { text: "Talk with CoCalc", hrefIncludes: "context=feature-compare" },
      { text: "AI workflows", hrefIncludes: "/features/ai" },
    ],
  },
  "/support": {
    requireText: ["CoCalc Support", "Choose an operating model"],
    requireLinks: [
      { text: "Review trust materials", hrefIncludes: "/policies/trust" },
      { text: "Compare operating models", hrefIncludes: "/products" },
      { text: "Review pricing", hrefIncludes: "/pricing" },
      { text: "Read the docs", hrefIncludes: "/docs" },
    ],
  },
  "/support/new": {
    requireText: ["Contact CoCalc Support"],
    requireLinks: [
      { text: "Email CoCalc", hrefIncludes: "help@cocalc.com" },
      { text: "trust materials", hrefIncludes: "/policies/trust" },
      { text: "the privacy policy", hrefIncludes: "/policies/privacy" },
    ],
  },
  "/products/cocalc-plus": {
    requireText: [
      "CoCalc Plus",
      "Need local CoCalc before choosing a shared path?",
      "Boundary: local, one-user runtime",
    ],
    requireLinks: [
      { text: "Install CoCalc Plus", hrefIncludes: "/products/cocalc-plus" },
      { text: "Review hosted plans", hrefIncludes: "/pricing" },
      { text: "Compare with Star", hrefIncludes: "/products/cocalc-star" },
    ],
  },
  "/products/cocalc-star": {
    requireText: [
      "CoCalc Star",
      "Is one public Ubuntu VM enough?",
      "Boundary: one public VM",
    ],
    requireLinks: [
      { text: "Install CoCalc Star", hrefIncludes: "/products/cocalc-star" },
      {
        text: "Compare with Launchpad",
        hrefIncludes: "/products/cocalc-launchpad",
      },
      {
        text: "Read Star setup guide",
        hrefIncludes: "/docs/self-hosting/cocalc-star",
      },
    ],
  },
  "/products/cocalc-launchpad": {
    requireText: [
      "CoCalc Launchpad",
      "Need a bounded private CoCalc deployment?",
      "Boundary: bounded private deployment",
    ],
    requireLinks: [
      {
        text: "Talk with CoCalc about Launchpad",
        hrefIncludes: "context=product-cocalc-launchpad",
      },
      { text: "Pricing and licensing", hrefIncludes: "/pricing" },
      { text: "Compare with Star", hrefIncludes: "/products/cocalc-star" },
    ],
  },
  "/products/cocalc-rocket": {
    requireText: [
      "CoCalc Rocket",
      "Planning an institutional private CoCalc deployment?",
      "Boundary: planned private cloud",
    ],
    requireLinks: [
      {
        text: "Talk with CoCalc about Rocket",
        hrefIncludes: "context=product-cocalc-rocket",
      },
      { text: "Pricing and licensing", hrefIncludes: "/pricing" },
      {
        text: "Compare with Launchpad",
        hrefIncludes: "/products/cocalc-launchpad",
      },
    ],
  },
  "/features": {
    requireText: [
      "AI workflows",
      "Notebooks and writing",
      "Runtime",
      "Teaching",
      "Languages",
    ],
    expectedOrder: [
      "AI workflows",
      "Notebooks and writing",
      "Runtime",
      "Teaching",
      "Languages",
    ],
    forbidText: ["Notebook, writing, and visual work"],
    requireSelectors: [".cocalc-feature-starter-card"],
    styleChecks: [
      {
        selector: ".cocalc-feature-starter-card",
        property: "backgroundColor",
        not: ["rgb(230, 244, 255)"],
      },
    ],
    requireLinks: [{ hrefIncludes: "/features/ai" }],
  },
  "/features/ai": {
    requireText: ["Agent thread", "Choose the AI path that fits"],
    forbidText: [
      "Codex thread",
      "Ready to use Codex in CoCalc?",
      "Built-in provider support",
      "Other agents can still run in terminals.",
    ],
    requireSelectors: [".cocalc-ai-workflow-panel"],
    styleChecks: [
      {
        selector: ".cocalc-ai-workflow-panel",
        property: "backgroundColor",
        not: ["rgb(11, 21, 34)", "rgb(15, 23, 42)"],
      },
    ],
    requireLinks: [
      { text: "Terminal workflows", hrefIncludes: "/features/terminal" },
    ],
  },
  "/features/latex-editor": {
    requireText: [
      "Keep the working tree together",
      "What stays with the paper",
      "Use computation as part of the writing process",
    ],
    forbidText: ["PDF build"],
  },
  "/features/sage": {
    requireText: [
      "Use Sage with the surrounding project.",
      "Course context",
      "Project context",
    ],
    requireSelectors: [".cocalc-feature-context-list"],
  },
  "/features/r-statistical-software": {
    requireText: [
      "Keep R close to the rest of the analysis.",
      "Project context",
    ],
    requireSelectors: [".cocalc-feature-context-list"],
  },
  "/features/julia": {
    requireText: [
      "Julia works best in CoCalc when the project matters.",
      "Project context",
    ],
    requireSelectors: [".cocalc-feature-context-list"],
  },
  "/features/octave": {
    requireText: [
      "Teach and run Octave without local setup drift.",
      "Project context",
    ],
    requireSelectors: [".cocalc-feature-context-list"],
  },
  "/guides": {
    requireText: [
      "Find the guide by task",
      "Codex agent chat",
      "Jupyter notebooks",
      "Terminal workflows",
      "From notebook to paper",
      "Installing software",
      "Reviewing agent commits",
      "Teaching with CoCalc",
      "Self-hosting CoCalc",
      "How CoCalc works",
    ],
    forbidSelectors: [".ant-tag"],
    requireSelectors: [".cocalc-guide-link-compact"],
    requireLinks: [
      {
        text: "From notebook to paper",
        hrefIncludes: "/paper-polishing/",
      },
    ],
  },
};

function usage() {
  return `Usage: node scripts/public-site-browser-qa.mjs [options]

Options:
  --base-url <url>       Public site origin to test. Default: ${DEFAULT_BASE_URL}
  --group <name>         Route group to test. Repeatable. Default: feature-index
  --route <path>         Direct route to test, e.g. /features/ai. Repeatable.
  --viewport <name>      desktop, tablet, or mobile. Repeatable. Default: all.
  --chrome-bin <path>    Chrome/Chromium binary. Defaults to CHROME_BIN or system paths.
  --wait-ms <ms>         Wait after page load before assertions. Default: ${DEFAULT_WAIT_MS}
  --list-groups          Print route groups and exit.
  --help                 Show this help.

Artifacts:
  Screenshots and results.json are always written under /tmp/${ARTIFACT_PREFIX}*.
`;
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    groups: [],
    routes: [],
    viewports: [],
    waitMs: DEFAULT_WAIT_MS,
    chromeBin: process.env.CHROME_BIN || "",
    listGroups: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    switch (arg) {
      case "--base-url":
        options.baseUrl = next().replace(/\/+$/, "");
        break;
      case "--group":
        options.groups.push(next());
        break;
      case "--route":
        options.routes.push(normalizeRoute(next()));
        break;
      case "--viewport":
        options.viewports.push(next());
        break;
      case "--chrome-bin":
        options.chromeBin = next();
        break;
      case "--wait-ms":
        options.waitMs = Number(next());
        if (!Number.isFinite(options.waitMs) || options.waitMs < 0) {
          throw new Error("--wait-ms must be a non-negative number");
        }
        break;
      case "--list-groups":
        options.listGroups = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.groups.length === 0 && options.routes.length === 0) {
    options.groups.push("feature-index");
  }
  if (options.viewports.length === 0) {
    options.viewports = Object.keys(VIEWPORTS);
  }

  return options;
}

function normalizeRoute(route) {
  if (!route.startsWith("/")) {
    return `/${route}`;
  }
  return route;
}

function resolveRoutes(groups, routes) {
  const resolved = [];
  for (const group of groups) {
    if (!ROUTE_GROUPS[group]) {
      throw new Error(
        `Unknown route group: ${group}. Use --list-groups to inspect choices.`,
      );
    }
    resolved.push(...ROUTE_GROUPS[group]);
  }
  resolved.push(...routes);
  return [...new Set(resolved.map(normalizeRoute))];
}

function resolveViewports(viewports) {
  return viewports.map((name) => {
    if (!VIEWPORTS[name]) {
      throw new Error(
        `Unknown viewport: ${name}. Expected ${Object.keys(VIEWPORTS).join(", ")}.`,
      );
    }
    return { name, ...VIEWPORTS[name] };
  });
}

function findChrome(chromeBin) {
  const candidates = [
    chromeBin,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      "Could not find Chrome/Chromium. Pass --chrome-bin or set CHROME_BIN.",
    );
  }
  return found;
}

function createArtifactDir() {
  const dir = mkdtempSync(join(tmpdir(), ARTIFACT_PREFIX));
  if (!dir.startsWith(join(tmpdir(), ARTIFACT_PREFIX))) {
    throw new Error(`Refusing to write artifacts outside /tmp: ${dir}`);
  }
  return dir;
}

function httpJson(port, method, endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: endpoint, method },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `${method} ${endpoint} -> ${res.statusCode}: ${body.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

class Cdp {
  constructor(wsUrl) {
    if (typeof WebSocket !== "function") {
      throw new Error("This script requires a Node runtime with WebSocket.");
    }
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(JSON.stringify(msg.error)));
        } else {
          resolve(msg.result || {});
        }
        return;
      }
      if (msg.method && this.events.has(msg.method)) {
        for (const fn of this.events.get(msg.method)) {
          fn(msg.params || {});
        }
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const fn = (params) => {
        const list = this.events.get(method) || [];
        this.events.set(
          method,
          list.filter((item) => item !== fn),
        );
        resolve(params);
      };
      this.events.set(method, [...(this.events.get(method) || []), fn]);
    });
  }

  close() {
    this.ws.close();
  }
}

async function waitForChrome(port, stderrRef) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await httpJson(port, "GET", "/json/version");
      return;
    } catch (_err) {
      await sleep(250);
    }
  }
  throw new Error(`Chrome did not start. stderr=${stderrRef.value}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(assertions, pass, message, detail = undefined) {
  assertions.push({ pass: Boolean(pass), message, detail });
}

function slug(route) {
  return route.replace(/^\//, "").replace(/\//g, "-") || "home";
}

function json(value) {
  return JSON.stringify(value);
}

async function inspectPage(cdp, route, viewportName) {
  const result = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(() => {
      const text = document.body.innerText || "";
      const headings = Array.from(document.querySelectorAll("h1,h2,h3")).map((el) => ({
        tag: el.tagName,
        text: (el.textContent || "").trim(),
      }));
      const doc = document.documentElement;
      const body = document.body;
      const scrollWidth = Math.max(doc.scrollWidth || 0, body.scrollWidth || 0);
      const clientWidth = Math.max(doc.clientWidth || 0, window.innerWidth || 0);
      const selectors = {};
      for (const selector of ${json(collectSelectors(route))}) {
        selectors[selector] = Array.from(document.querySelectorAll(selector)).map((el) => {
          const styles = getComputedStyle(el);
          return {
            text: (el.textContent || "").trim().replace(/\\s+/g, " "),
            backgroundColor: styles.backgroundColor,
            display: styles.display,
          };
        });
      }
      const links = Array.from(document.querySelectorAll("a")).map((a) => ({
        text: (a.textContent || "").trim().replace(/\\s+/g, " "),
        href: a.href,
      }));
      return {
        route: ${json(route)},
        viewport: ${json(viewportName)},
        url: location.href,
        title: document.title,
        text,
        headings,
        scrollWidth,
        clientWidth,
        overflow: scrollWidth - clientWidth,
        selectors,
        links,
      };
    })()`,
  });
  return result.result.value;
}

function collectSelectors(route) {
  const rule = ROUTE_RULES[route] || {};
  return [
    ...(rule.requireSelectors || []),
    ...(rule.forbidSelectors || []),
    ...(rule.styleChecks || []).map((check) => check.selector),
  ];
}

function evaluateRules(page, assertions) {
  const rule = ROUTE_RULES[page.route] || {};
  assert(
    assertions,
    page.overflow <= 2,
    `${page.route} ${page.viewport}: no horizontal overflow`,
    {
      overflow: page.overflow,
      scrollWidth: page.scrollWidth,
      clientWidth: page.clientWidth,
    },
  );

  for (const phrase of GLOBAL_FORBIDDEN_TEXT) {
    assert(
      assertions,
      !page.text.includes(phrase),
      `${page.route} ${page.viewport}: global stale/internal phrase absent: ${phrase}`,
    );
  }

  for (const phrase of rule.requireText || []) {
    assert(
      assertions,
      page.text.includes(phrase),
      `${page.route} ${page.viewport}: required text present: ${phrase}`,
    );
  }

  for (const phrase of rule.forbidText || []) {
    assert(
      assertions,
      !page.text.includes(phrase),
      `${page.route} ${page.viewport}: stale route text absent: ${phrase}`,
    );
  }

  if (rule.expectedOrder) {
    const order = rule.expectedOrder.map((phrase) => page.text.indexOf(phrase));
    assert(
      assertions,
      order.every((idx) => idx >= 0),
      `${page.route} ${page.viewport}: ordered text all present`,
      { expectedOrder: rule.expectedOrder, order },
    );
    assert(
      assertions,
      order.every((idx, i) => i === 0 || idx > order[i - 1]),
      `${page.route} ${page.viewport}: ordered text appears in expected order`,
      { expectedOrder: rule.expectedOrder, order },
    );
  }

  for (const selector of rule.requireSelectors || []) {
    assert(
      assertions,
      (page.selectors[selector] || []).length > 0,
      `${page.route} ${page.viewport}: selector present: ${selector}`,
    );
  }

  for (const selector of rule.forbidSelectors || []) {
    assert(
      assertions,
      (page.selectors[selector] || []).length === 0,
      `${page.route} ${page.viewport}: selector absent: ${selector}`,
    );
  }

  for (const check of rule.styleChecks || []) {
    const matches = page.selectors[check.selector] || [];
    assert(
      assertions,
      matches.length > 0,
      `${page.route} ${page.viewport}: style selector present: ${check.selector}`,
    );
    const values = matches.map((match) => match[check.property]);
    assert(
      assertions,
      values.every((value) => !check.not.includes(value)),
      `${page.route} ${page.viewport}: ${check.selector} ${check.property} avoids disallowed values`,
      { property: check.property, values, disallowed: check.not },
    );
  }

  for (const linkRule of rule.requireLinks || []) {
    const link = page.links.find(
      (candidate) =>
        (!linkRule.text || candidate.text.includes(linkRule.text)) &&
        candidate.href.includes(linkRule.hrefIncludes),
    );
    assert(
      assertions,
      Boolean(link),
      `${page.route} ${page.viewport}: route-specific link present: ${linkRule.text || "*"} -> ${linkRule.hrefIncludes}`,
      {
        linkRule,
        matchingLinks: page.links.filter((candidate) => {
          if (linkRule.text) {
            return candidate.text.includes(linkRule.text);
          }
          return candidate.href.includes(linkRule.hrefIncludes);
        }),
      },
    );
  }
}

async function captureScrollScreenshots(cdp, outDir, route, viewportName) {
  const maxScrollResult = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression:
      "Math.max(0, document.documentElement.scrollHeight - window.innerHeight)",
  });
  const maxScroll = Number(maxScrollResult.result.value || 0);
  const positions = [
    ["top", 0],
    ["mid", Math.floor(maxScroll * 0.5)],
    ["bottom", maxScroll],
  ];

  const paths = [];
  for (const [name, y] of positions) {
    await cdp.send("Runtime.evaluate", {
      expression: `window.scrollTo(0, ${Number(y)})`,
      awaitPromise: true,
    });
    await sleep(250);
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const filePath = join(outDir, `${slug(route)}-${viewportName}-${name}.png`);
    writeFileSync(filePath, Buffer.from(shot.data, "base64"));
    paths.push(filePath);
  }
  return paths;
}

async function run(options) {
  const routes = resolveRoutes(options.groups, options.routes);
  const viewports = resolveViewports(options.viewports);
  const chromeBin = findChrome(options.chromeBin);
  const outDir = createArtifactDir();
  const port = 9400 + Math.floor(Math.random() * 500);
  const stderrRef = { value: "" };
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${join(outDir, "profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.on("data", (data) => {
    stderrRef.value += String(data);
  });

  const assertions = [];
  const pageResults = [];
  const screenshots = [];
  let cdp;

  try {
    await waitForChrome(port, stderrRef);
    const target = await httpJson(port, "PUT", "/json/new?about:blank");
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    for (const viewport of viewports) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });

      for (const route of routes) {
        const url = `${options.baseUrl}${route}?qa=${Date.now()}`;
        const loaded = cdp.once("Page.loadEventFired");
        await cdp.send("Page.navigate", { url });
        await loaded;
        await sleep(options.waitMs);

        const page = await inspectPage(cdp, route, viewport.name);
        pageResults.push(page);
        evaluateRules(page, assertions);
        screenshots.push(
          ...(await captureScrollScreenshots(
            cdp,
            outDir,
            route,
            viewport.name,
          )),
        );
      }
    }
  } finally {
    if (cdp) {
      cdp.close();
    }
    chrome.kill("SIGTERM");
  }

  const failed = assertions.filter((item) => !item.pass);
  const result = {
    baseUrl: options.baseUrl,
    outDir,
    routes,
    viewports: viewports.map((viewport) => viewport.name),
    assertionCount: assertions.length,
    failedCount: failed.length,
    failed,
    screenshots,
    assertions,
    pageResults,
  };
  writeFileSync(join(outDir, "results.json"), JSON.stringify(result, null, 2));
  return result;
}

function printGroups() {
  for (const [name, routes] of Object.entries(ROUTE_GROUPS)) {
    console.log(`${name}: ${routes.join(", ")}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.listGroups) {
    printGroups();
    return;
  }

  const result = await run(options);
  console.log(
    JSON.stringify(
      {
        outDir: result.outDir,
        routes: result.routes,
        viewports: result.viewports,
        assertionCount: result.assertionCount,
        failedCount: result.failedCount,
        failed: result.failed,
      },
      null,
      2,
    ),
  );
  if (result.failedCount > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
