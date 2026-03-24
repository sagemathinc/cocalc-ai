import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const TRANSPILED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

export async function loadScriptModuleFromFile(
  filename: string,
): Promise<unknown> {
  const absolute = path.resolve(filename);
  const source = await fs.readFile(absolute, "utf8");
  return await loadScriptModule({
    filename: absolute,
    source,
  });
}

export async function loadScriptModule({
  filename,
  source,
}: {
  filename: string;
  source: string;
}): Promise<unknown> {
  const module = { exports: {} as any };
  const sandbox: Record<string, unknown> = {
    module,
    exports: module.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    AbortController,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const compiled = compileScript({
    filename,
    source,
  });
  const script = new vm.Script(compiled, {
    filename,
  });
  script.runInContext(sandbox, {
    displayErrors: true,
  });
  return module.exports;
}

export function resolveScriptHandler(moduleExports: unknown): Function {
  const candidate =
    typeof moduleExports === "function"
      ? moduleExports
      : ((moduleExports as any)?.default ?? (moduleExports as any)?.run);
  if (typeof candidate !== "function") {
    throw new Error(
      "script must export a function (default export or module.exports)",
    );
  }
  return candidate;
}

function compileScript({
  filename,
  source,
}: {
  filename: string;
  source: string;
}): string {
  if (!TRANSPILED_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    return source;
  }
  const result = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      allowJs: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
      isolatedModules: true,
      strict: false,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
    },
  });
  const diagnostics = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (value) => value,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  }
  return result.outputText;
}
