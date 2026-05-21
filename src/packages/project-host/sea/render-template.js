#!/usr/bin/env node

/*
Render a SEA entrypoint template without depending on envsubst.

Usage:
  render-template.js <template> <output> <NAME> <VERSION> <MAIN>
*/

const fs = require("node:fs");

const [templatePath, outputPath, name, version, main] = process.argv.slice(2);

if (!templatePath || !outputPath || !name || !version || !main) {
  console.error(
    "usage: render-template.js <template> <output> <NAME> <VERSION> <MAIN>",
  );
  process.exit(2);
}

const replacements = {
  NAME: name,
  VERSION: version,
  MAIN: main,
};

let rendered = fs.readFileSync(templatePath, "utf8");
for (const [key, value] of Object.entries(replacements)) {
  rendered = rendered.replaceAll(`\${${key}}`, value);
}

for (const key of Object.keys(replacements)) {
  if (rendered.includes(`\${${key}}`)) {
    console.error(`failed to replace \${${key}} in ${templatePath}`);
    process.exit(1);
  }
}

fs.writeFileSync(outputPath, rendered);
