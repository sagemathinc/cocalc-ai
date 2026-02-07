#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "dist", "bin");
const files = ["start.js", "ssh.js"];
const shebang = "#!/usr/bin/env node\n";

for (const file of files) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    continue;
  }
  const content = fs.readFileSync(full, "utf8");
  if (content.startsWith("#!")) {
    continue;
  }
  fs.writeFileSync(full, shebang + content, "utf8");
}
