const { mkdirSync, copyFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const files = [
  ["apps/builtin-template-catalog.json", "dist/apps/builtin-template-catalog.json"],
];

for (const [src, dest] of files) {
  const sourcePath = resolve(__dirname, "..", src);
  const destPath = resolve(__dirname, "..", dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(sourcePath, destPath);
}
