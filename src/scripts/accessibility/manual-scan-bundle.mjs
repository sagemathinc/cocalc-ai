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
  const pageCss = await readFile(
    join(root, "packages/frontend/collaborators/page.css"),
    "utf8",
  );
  await build({
    stdin: {
      contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {ConfigProvider,theme} from 'antd';
      import {ScanFiles} from '${join(root, "packages/frontend/collaborators/scan-projects.tsx")}';
      import {appearanceStyleSheet} from '@cocalc/util/appearance-palette';
      import {PeopleViewTabs} from '${join(root, "packages/frontend/collaborators/workspace-tabs.tsx")}';
      const params=new URL(location.href).searchParams; const dark=params.has('dark'); const actor=params.get('actor')??'first';
      document.documentElement.dataset.cocalcTheme=dark?'dark':'light';
      const style=document.createElement('style');style.textContent=appearanceStyleSheet()+${JSON.stringify(pageCss)};document.head.append(style);
      document.getElementById('root').className='collaborators-page';
      const api={scanProjects:async input=>{const r=await fetch(actor==='first'?'/rpc':'/rpc/second',{method:'POST',body:JSON.stringify(input)});const value=await r.json(); if(!r.ok) throw Error(value.error); if(input.action==='projects') globalThis.scanFixtureOfflineHosts=(value.projects??[]).filter(p=>p.project_id===globalThis.scanFixtureUnavailableProject).map(p=>p.host_id); return value;}};
      function App(){ const [view,setView]=useState('conversations'); return <>
        <PeopleViewTabs id="people" view={view} onView={setView} scanSupported/>
        <div role="tabpanel" id={'people-panel-'+view} aria-labelledby={'people-tab-'+view} tabIndex={0}>
          {view==='scan-files' && <ScanFiles accountId={actor} api={api}/>}
        </div></>; }
      createRoot(document.getElementById('root')).render(<ConfigProvider theme={{algorithm:dark?theme.darkAlgorithm:theme.defaultAlgorithm,token:{motion:false}}}><App/></ConfigProvider>);

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
          build.onResolve({ filter: /^@cocalc\/util\/array-range$/ }, () => ({
            path: join(root, "packages/util/array-range.ts"),
          }));
          build.onResolve(
            { filter: /^@cocalc\/frontend\/docs\/link$/ },
            () => ({ path: "docs-link", namespace: "fixture" }),
          );
          build.onResolve({ filter: /^@cocalc\/util\/misc$/ }, () => ({
            path: "uuid",
            namespace: "fixture",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            resolveDir: join(root, "packages/frontend"),
            contents:
              args.path === "docs-link"
                ? `import React from 'react'; export const DocsLink=({slug,children})=>React.createElement('a',{href:'/docs/'+slug},children);`
                : args.path === "redux"
                  ? `import {fromJS} from 'immutable';
                     export const redux={getActions:()=>undefined};
                     export const useActions=()=>({ensure_host_info:async()=>undefined});
                     const ready=fromJS({status:'running',online:true,ready:true});
                     const hosts={get:id=>id && !globalThis.scanFixtureOfflineHosts?.includes(id) ? ready : undefined};
                     export const useTypedRedux=()=>hosts;`
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
  const css = await readFile(join(temp, "app.css"), "utf8");
  const js = await readFile(join(temp, "app.js"), "utf8");
  return (
    js +
    `;{const style=document.createElement("style");style.textContent=${JSON.stringify(css)};document.head.append(style);}`
  );
}
