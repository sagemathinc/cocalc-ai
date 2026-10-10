import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  describeCommand,
  isInfrastructure,
  Favicons,
  listeningPorts,
  pageTitle,
  projectServers,
  recentSites,
} from "./start-page";

test("listening ports come from /proc/net/tcp and tcp6", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 111 1 0",
    "   1: 0100007F:1435 0100007F:9999 01 00000000:00000000 00:00000000 00000000  2000        0 222 1 0",
  ].join("\n");
  const tcp6 = [
    "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 00000000000000000000000000000000:22B8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  2000        0 333 1 0",
  ].join("\n");
  const ports = listeningPorts((path) => (path.endsWith("6") ? tcp6 : tcp));
  assert.deepEqual(
    [...ports.entries()],
    [
      [5173, ["111"]],
      [8888, ["333"]],
    ],
  );
});

test("what runs a server, and a page's title", () => {
  assert.equal(
    describeCommand("node /home/user/app/node_modules/.bin/vite --port 5173"),
    "node vite",
  );
  assert.equal(
    describeCommand("/usr/bin/python3 -m http.server"),
    "python3 http.server",
  );
  assert.equal(describeCommand("jupyter-lab"), "jupyter-lab");
  assert.equal(
    pageTitle("<html><head><title>\n  My &amp; App </title></head>"),
    "My & App",
  );
  assert.equal(pageTitle("<p>no title</p>"), "");
  // Users' servers may run on CoCalc's node; CoCalc's own programs do not count.
  assert.equal(
    isInfrastructure("/opt/cocalc/bin/node /home/user/app/server.js"),
    false,
  );
  assert.equal(
    isInfrastructure(
      "/opt/cocalc/bin/node /opt/cocalc/bin2/cocalc-cli.js project browser serve",
    ),
    true,
  );
  assert.equal(
    isInfrastructure(
      "/opt/cocalc/bin2/cocalc-chromium/browser/headless_shell --headless",
    ),
    true,
  );
  assert.equal(isInfrastructure("python3 -m http.server"), false);
});

test("the project's web servers: titled, ours excluded, non-HTTP skipped", async () => {
  const app = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<title>My dev app</title>");
  });
  const ours = createServer((_req, res) => res.end("ok"));
  const listen = (s: any) =>
    new Promise<number>((r) =>
      s.listen(0, "127.0.0.1", () => r(s.address().port)),
    );
  const appPort = await listen(app);
  const ourPort = await listen(ours);
  try {
    const servers = await projectServers(
      new Set([ourPort]),
      1000,
      new Set([appPort, ourPort]),
    );
    const mine = servers.find((s) => s.port === appPort);
    assert.deepEqual(mine, {
      port: appPort,
      url: `http://localhost:${appPort}/`,
      label: "My dev app",
    });
    assert.ok(!servers.some((s) => s.port === ourPort));
  } finally {
    app.close();
    ours.close();
  }
});

test("recent sites: newest first, one per host, no local servers", () => {
  const dir = mkdtempSync(join(tmpdir(), "history-test-"));
  try {
    const file = join(dir, "History");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER)",
    );
    const add = db.prepare(
      "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, 1, ?, ?)",
    );
    add.run("https://github.com/sagemathinc", "sagemathinc", 50, 0);
    add.run("https://www.github.com/", "GitHub", 40, 0);
    add.run("http://localhost:5173/", "dev", 60, 0);
    add.run("https://arxiv.org/abs/1234", "", 30, 0);
    add.run("https://hidden.example/", "Hidden", 70, 1);
    add.run("chrome://settings", "Settings", 80, 0);
    db.close();
    assert.deepEqual(recentSites(file), [
      { url: "https://github.com/sagemathinc", title: "sagemathinc" },
      { url: "https://arxiv.org/abs/1234", title: "arxiv.org" },
    ]);
    assert.deepEqual(recentSites(join(dir, "missing")), []);
    assert.deepEqual(recentSites(null), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("site icons: images only, cached, http(s) only", async () => {
  let hits = 0;
  const site = createServer((req, res) => {
    hits++;
    if (req.url === "/favicon.ico") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 0, 1, 0]));
    } else if (req.url === "/icon.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.from([137, 80, 78, 71]));
    } else {
      res.setHeader("content-type", "text/html");
      res.end("<p>not an image</p>");
    }
  });
  const port = await new Promise<number>((r) =>
    site.listen(0, "127.0.0.1", () => r((site.address() as any).port)),
  );
  try {
    const icons = new Favicons();
    const png = await icons.get(`http://127.0.0.1:${port}/icon.png`);
    assert.equal(png?.type, "image/png");
    assert.equal(
      (await icons.get(`http://127.0.0.1:${port}/favicon.ico`))?.type,
      "image/x-icon",
    );
    assert.equal(await icons.get(`http://127.0.0.1:${port}/page`), null);
    assert.equal(await icons.get("file:///etc/passwd"), null);
    const before = hits;
    await icons.get(`http://127.0.0.1:${port}/icon.png`);
    assert.equal(hits, before);
  } finally {
    site.close();
  }
});
