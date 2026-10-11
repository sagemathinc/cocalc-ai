import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  describeCommand,
  isInfrastructure,
  isPublicAddress,
  Favicons,
  listeningPorts,
  pageTitle,
  projectServers,
  recentSites,
  sniffImage,
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

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);

async function iconSite(
  handler: (url: string, res: any) => void,
): Promise<{ port: number; hits: string[]; close: () => void }> {
  const hits: string[] = [];
  const site = createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req.url ?? "", res);
  });
  const port = await new Promise<number>((r) =>
    site.listen(0, "127.0.0.1", () => r((site.address() as any).port)),
  );
  return { port, hits, close: () => site.close() };
}

test("site icons: images by their content, cached, http(s) only", async () => {
  const site = await iconSite((url, res) => {
    if (url === "/favicon.ico") {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 0, 1, 0, 1, 0]));
    } else if (url === "/icon.png") {
      res.setHeader("content-type", "image/png");
      res.end(PNG);
    } else if (url === "/lying.png") {
      // An HTML page that says it is an image.
      res.setHeader("content-type", "image/png");
      res.end("<script>alert(1)</script>");
    } else if (url === "/huge.png") {
      res.setHeader("content-type", "image/png");
      res.end(Buffer.concat([PNG, Buffer.alloc(200 * 1024)]));
    } else {
      res.setHeader("content-type", "text/html");
      res.end("<p>not an image</p>");
    }
  });
  try {
    // Loopback allowed here only to have a server to fetch from.
    const icons = new Favicons({ allowAddress: (a) => a === "127.0.0.1" });
    const base = `http://127.0.0.1:${site.port}`;
    assert.equal((await icons.get(`${base}/icon.png`))?.type, "image/png");
    assert.equal(
      (await icons.get(`${base}/favicon.ico`))?.type,
      "image/x-icon",
    );
    assert.equal(await icons.get(`${base}/lying.png`), null);
    assert.equal(await icons.get(`${base}/huge.png`), null);
    assert.equal(await icons.get(`${base}/page`), null);
    assert.equal(await icons.get("file:///etc/passwd"), null);
    const before = site.hits.length;
    await icons.get(`${base}/icon.png`);
    assert.equal(site.hits.length, before);
  } finally {
    site.close();
  }
});

test("site icons: never from the project, the host or a private network", async () => {
  const site = await iconSite((_url, res) => res.end(PNG));
  try {
    const icons = new Favicons({
      lookup: async (host) =>
        ({
          "internal.test": ["10.1.2.3"],
          "mixed.test": ["93.184.216.34", "127.0.0.1"],
        })[host] ?? [],
    });
    for (const url of [
      `http://127.0.0.1:${site.port}/icon.png`,
      `http://localhost:${site.port}/icon.png`,
      `http://[::1]:${site.port}/icon.png`,
      "http://169.254.169.254/latest/meta-data/",
      "http://internal.test/icon.png",
      "http://mixed.test/icon.png",
      "http://user:pw@example.com/icon.png",
    ])
      assert.equal(await icons.get(url), null, url);
    // Refused before connecting.
    assert.deepEqual(site.hits, []);
  } finally {
    site.close();
  }
});

test("site icons: each redirect is checked again, and the checked address is the one used", async () => {
  const site = await iconSite((url, res) => {
    if (url === "/to-internal") {
      res.statusCode = 302;
      res.setHeader("location", "http://internal.test/icon.png");
      res.end();
    } else if (url === "/to-icon") {
      res.statusCode = 301;
      res.setHeader("location", "/icon.png");
      res.end();
    } else res.end(PNG);
  });
  try {
    // "public.test" is the server above; nothing else is reachable.
    const icons = new Favicons({
      lookup: async (host) =>
        host === "public.test" ? ["127.0.0.1"] : ["10.9.9.9"],
      allowAddress: (a) => a === "127.0.0.1",
    });
    const base = `http://public.test:${site.port}`;
    assert.equal((await icons.get(`${base}/to-icon`))?.type, "image/png");
    assert.equal(await icons.get(`${base}/to-internal`), null);
    assert.deepEqual(site.hits, ["/to-icon", "/icon.png", "/to-internal"]);
  } finally {
    site.close();
  }
});

test("public addresses", () => {
  for (const address of [
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])
    assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "localhost",
    "",
  ])
    assert.equal(isPublicAddress(address), false, address);
});

test("image types come from the bytes", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0])), "image/x-icon");
  assert.equal(
    sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>')),
    "image/svg+xml",
  );
  assert.equal(sniffImage(Buffer.from("<html><svg></svg></html>")), null);
  assert.equal(sniffImage(Buffer.from("<p>hi</p>")), null);
  assert.equal(sniffImage(Buffer.from([1, 2])), null);
});
