import type { WebpackPluginInstance } from "@rspack/core";
import { writeFileSync } from "fs";
import { resolve } from "path";

function normalizeModuleName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const packagesRoot = resolve(process.cwd(), "..").replace(/\\/g, "/");
  if (normalized.startsWith(`${packagesRoot}/`)) {
    return normalized.slice(packagesRoot.length + 1);
  }
  return normalized;
}

function getModuleName(module: any): string | null {
  const resource =
    module?.nameForCondition?.() ??
    module?.resource ??
    module?.rootModule?.resource ??
    module?.userRequest;
  if (typeof resource === "string" && resource) {
    return normalizeModuleName(resource);
  }

  const identifier =
    typeof module?.identifier === "function" ? module.identifier() : null;
  if (typeof identifier !== "string" || !identifier) {
    return null;
  }

  const noLoaders = identifier.split("!").pop() ?? identifier;
  const candidate = noLoaders.split("|").pop() ?? noLoaders;
  return normalizeModuleName(candidate);
}

class ChunkStatsPlugin implements WebpackPluginInstance {
  name = "ChunkStatsPlugin";

  apply(compiler: any): void {
    compiler.hooks.done.tap(this.name, (stats: any) => {
      const compilation = stats.compilation;
      const outputPath = compilation?.outputOptions?.path;
      if (typeof outputPath !== "string" || !outputPath) {
        return;
      }

      const chunks: Record<string, { files: string[]; modules: string[] }> = {};
      for (const chunk of compilation.chunks ?? []) {
        if (typeof chunk?.name !== "string" || !chunk.name) {
          continue;
        }

        const files = Array.from(chunk.files ?? [])
          .filter(
            (file): file is string =>
              typeof file === "string" && /\.(?:js|css)$/.test(file),
          )
          .sort();

        const modules = new Set<string>();
        const chunkModules =
          compilation.chunkGraph?.getChunkModulesIterable?.(chunk);
        if (chunkModules != null) {
          for (const module of chunkModules) {
            const name = getModuleName(module);
            if (name != null) {
              modules.add(name);
            }
          }
        }

        chunks[chunk.name] = {
          files,
          modules: [...modules].sort(),
        };
      }

      writeFileSync(
        resolve(outputPath, "chunk-stats.json"),
        JSON.stringify({ chunks }, null, 2),
      );
    });
  }
}

export default function chunkStatsPlugin(registerPlugin) {
  registerPlugin(
    "ChunkStatsPlugin -- generate compact chunk-stats.json",
    new ChunkStatsPlugin(),
  );
}
