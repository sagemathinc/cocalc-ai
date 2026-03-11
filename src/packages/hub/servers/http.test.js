const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("hub http server errors are fatal", () => {
  const pkgRoot = path.resolve(__dirname, "..");
  const distHttp = path.join(pkgRoot, "dist", "servers", "http.js");
  const expressPath = path.join(pkgRoot, "node_modules", "express");
  const script = `
    const net = require("net");
    const express = require(${JSON.stringify(expressPath)});
    const init = require(${JSON.stringify(distHttp)}).default;
    (async () => {
      const blocker = net.createServer();
      await new Promise((resolve, reject) =>
        blocker.listen(0, "127.0.0.1", (err) => (err ? reject(err) : resolve())),
      );
      const addr = blocker.address();
      const port = typeof addr === "object" && addr ? addr.port : undefined;
      const server = init({ app: express() });
      server.listen(port, "127.0.0.1");
      setTimeout(() => process.exit(0), 500);
    })().catch((err) => {
      console.error(err);
      process.exit(2);
    });
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.resolve(pkgRoot, "..", "..", "..", ".."),
    encoding: "utf8",
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /EADDRINUSE|hub http server error/,
  );
});
