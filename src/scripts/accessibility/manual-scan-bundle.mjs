// Shared real-component bundle for deterministic accessibility and real-service
// browser acceptance tests. No Scan implementation or RPC responses are mocked here.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
export const root = resolve(import.meta.dirname, "../..");
export const require = createRequire(
  join(root, "packages/frontend/package.json"),
);
const { build } = require("esbuild");
export async function scanBrowserBundle(temp) {
  await build({
    stdin: {
      contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ConfigProvider,theme} from 'antd';
      import {ScanProjects} from '${join(root, "packages/frontend/collaborators/scan-projects.tsx")}';
      const params=new URL(location.href).searchParams; const dark=params.has('dark'); const actor=params.get('actor')??'first';
      document.body.style.background=dark?'#141414':'white';document.body.style.color=dark?'white':'black';
      createRoot(document.getElementById('root')).render(<ConfigProvider theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,token:{motion:false}}}>
      <ScanProjects accountId={actor} api={{scanProjects:async input=>{const r=await fetch(actor==='first'?'/rpc':'/rpc/second',{method:'POST',body:JSON.stringify(input)});const value=await r.json(); if(!r.ok) throw Error(value.error);return value;}}}/></ConfigProvider>);
    `,
      loader: "tsx",
      resolveDir: join(root, "packages/frontend"),
    },
    outfile: join(temp, "app.js"),
    bundle: true,
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "fixture-dependencies",
        setup(build) {
          build.onResolve(
            { filter: /^@cocalc\/frontend\/app-framework$/ },
            () => ({ path: "redux", namespace: "fixture" }),
          );
          build.onResolve({ filter: /^@cocalc\/util\/misc$/ }, () => ({
            path: "uuid",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents:
              args.path === "redux"
                ? "export const redux={getActions:()=>undefined};"
                : "export const uuid=()=>crypto.randomUUID();",
          }));
          build.onResolve({ filter: /^@cocalc\/frontend\// }, async (args) => {
            const name = join(
              root,
              "packages/frontend",
              args.path.replace("@cocalc/frontend/", ""),
            );
            for (const ext of [".tsx", ".ts"]) {
              try {
                await readFile(name + ext);
                return { path: name + ext };
              } catch {}
            }
          });
        },
      },
    ],
  });
  return await readFile(join(temp, "app.js"));
}
