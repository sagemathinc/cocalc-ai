const fs = require("node:fs");
const path = require("node:path");

function patchFile(file, patchFn) {
  const original = fs.readFileSync(file, "utf8");
  const patched = patchFn(original);
  if (patched !== original) fs.writeFileSync(file, patched);
}

function main() {
  const dist = path.join(
    __dirname,
    "..",
    "node_modules",
    "next-rest-framework",
    "dist",
  );

  // Keep existing CoCalc patch: ensure this interface is exported for typings.
  patchFile(path.join(dist, "index.d.ts"), (text) =>
    text.replace("interface NrfOasData {", "export interface NrfOasData {"),
  );

  // Patch NRF CLI route module handling:
  // 1) Support either `res.default` or `res` as the actual route handler.
  // 2) Quietly skip non-NRF routes (missing _getPathsForRoute), which are
  //    common in this codebase.
  const cliFiles = [
    path.join(dist, "cli", "index.js"),
    path.join(dist, "cli", "generate.js"),
    path.join(dist, "cli", "validate.js"),
    path.join(dist, "cli", "index.mjs"),
    path.join(dist, "cli", "generate.mjs"),
    path.join(dist, "cli", "validate.mjs"),
  ];
  for (const file of cliFiles) {
    if (!fs.existsSync(file)) continue;
    patchFile(file, (text) => {
      let out = text;

      // Config discovery block.
      out = out.replace(
        /const _config = res(?:\.default)?\._nextRestFrameworkConfig;/g,
        "const docsTarget = res.default ?? res;\n            const _config = docsTarget._nextRestFrameworkConfig;",
      );

      // Route extraction block.
      out = out.replace(
        /const isDocsHandler = !!res(?:\.default)?\._nextRestFrameworkConfig;\s*if \(isDocsHandler\) \{\s*return;\s*\}\s*const data = await res(?:\.default)?\._getPathsForRoute\(/g,
        "const docsTarget = res.default ?? res;\n            const isDocsHandler = !!docsTarget._nextRestFrameworkConfig;\n            if (isDocsHandler) {\n              return;\n            }\n            const getPathsForRoute = docsTarget?._getPathsForRoute;\n            if (typeof getPathsForRoute !== \"function\") {\n              return;\n            }\n            const data = await getPathsForRoute(",
      );

      // App-router handlers block.
      out = out.replace(
        /const isDocsHandler = !!handler(?:\.default)?\._nextRestFrameworkConfig;\s*if \(isDocsHandler\) \{\s*continue;\s*\}\s*const data = await handler(?:\.default)?\._getPathsForRoute\(/g,
        "const docsTarget = handler.default ?? handler;\n              const isDocsHandler = !!docsTarget._nextRestFrameworkConfig;\n              if (isDocsHandler) {\n                continue;\n              }\n              const getPathsForRoute = docsTarget?._getPathsForRoute;\n              if (typeof getPathsForRoute !== \"function\") {\n                continue;\n              }\n              const data = await getPathsForRoute(",
      );

      return out;
    });
  }
}

main();
