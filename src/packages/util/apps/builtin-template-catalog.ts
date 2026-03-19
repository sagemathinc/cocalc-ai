/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppTemplateCatalogV1 } from "./template-catalog";

export const BUILTIN_APP_TEMPLATE_CATALOG: AppTemplateCatalogV1 = {
  version: 1,
  kind: "cocalc-app-template-catalog",
  source: "builtin",
  published_at: "2026-03-09T00:00:00.000Z",
  templates: [
    {
      id: "jupyterlab",
      title: "JupyterLab",
      category: "core",
      priority: 100,
      homepage: "https://jupyter.org/",
      description: "Interactive notebooks, terminals, and files.",
      detect: {
        commands: ["jupyter lab --version", "jupyter-lab --version"],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y jupyter jupyter-notebook jupyter-server python3-jupyterlab-server python3-ipykernel python3-pip && python3 -m pip install --break-system-packages --ignore-installed jupyterlab",
        hint: "On CoCalc's usual Ubuntu/root images, do not try to apt-install a top-level jupyterlab package. Install the distro Jupyter stack first, then layer the JupyterLab Python package with pip.",
        agent_prompt:
          "Install JupyterLab in the current project so the managed JupyterLab app can start. On maintained Ubuntu launchpad images, do not spend time searching for a top-level jupyterlab apt package. Install the distro Jupyter server/notebook packages, then layer the JupyterLab Python package with pip using --break-system-packages --ignore-installed. Verify the resulting 'jupyter lab --version' and explain any caveats.",
        recipes: [
          {
            id: "ubuntu-apt-plus-pip",
            match: {
              os_family: ["debian", "ubuntu"],
            },
            commands: [
              "apt-get update",
              "apt-get install -y jupyter jupyter-notebook jupyter-server python3-jupyterlab-server python3-ipykernel python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed jupyterlab",
            ],
            notes:
              "Ubuntu 24.04 does not ship a top-level jupyterlab apt package, so install the distro Jupyter server stack first, then layer the JupyterLab application with pip.",
          },
        ],
      },
      preset: {
        id: "jupyterlab",
        title: "JupyterLab",
        kind: "service",
        preferred_port: "6002",
        service_open_mode: "port",
        health_path: "/lab",
        command:
          'base_url="${APP_BASE_URL/\\/proxy\\//\\/port\\/}"; jupyter lab --allow-root --port-retries=0 --no-browser --NotebookApp.token= --NotebookApp.password= --ServerApp.disable_check_xsrf=True --NotebookApp.allow_remote_access=True --NotebookApp.mathjax_url=/cdn/mathjax/MathJax.js --NotebookApp.base_url="${base_url}" --ServerApp.base_url="${base_url}" --ip=${HOST:-127.0.0.1} --port=${PORT}',
      },
      verify: {
        commands: ["jupyter lab --version", "python3 -m jupyterlab --version"],
      },
      agent_prompt_seed:
        "On the usual Ubuntu launchpad image, skip apt package discovery for jupyterlab itself and use the tested apt-plus-pip recipe directly unless the runtime is already installed.",
    },
    {
      id: "code-server",
      title: "code-server",
      category: "core",
      priority: 95,
      homepage: "https://code-server.dev/",
      description: "VS Code in the browser, proxied as a managed app.",
      detect: {
        commands: ["code-server --version"],
      },
      install: {
        strategy: "curated",
        command: "curl -fsSL https://code-server.dev/install.sh | sh",
        hint: "code-server is not installed in this project image yet. The upstream installer works well on most Linux systems.",
        agent_prompt:
          "Install code-server in the current project so the managed code-server app can start. Use the safest practical Linux installation method, verify 'code-server --version', and summarize anything the user should know.",
      },
      preset: {
        id: "code-server",
        title: "code-server",
        kind: "service",
        preferred_port: "6004",
        service_open_mode: "proxy",
        command:
          "code-server --bind-addr=${HOST:-127.0.0.1}:${PORT} --auth=none",
      },
      verify: {
        commands: ["code-server --version"],
      },
    },
    {
      id: "pluto",
      title: "Pluto",
      category: "core",
      priority: 90,
      homepage: "https://plutojl.org/",
      description: "Reactive Julia notebooks.",
      detect: {
        commands: [
          "julia -e 'Base.find_package(\"Pluto\") |> isnothing && exit(1)'",
        ],
      },
      install: {
        strategy: "curated",
        command: "julia -e 'using Pkg; Pkg.add(\"Pluto\")'",
        hint: "Pluto needs Julia plus the Pluto package in this project environment.",
        agent_prompt:
          "Install Pluto for the current project so the managed Pluto app can start. Use Julia package tooling, verify the package is available, and mention any environment assumptions.",
      },
      preset: {
        id: "pluto",
        title: "Pluto",
        kind: "service",
        preferred_port: "6005",
        service_open_mode: "proxy",
        command:
          'julia -e \'import Pluto; Pluto.run(launch_browser=false, require_secret_for_access=false, host=get(ENV,"HOST","127.0.0.1"), port=parse(Int, ENV["PORT"]))\'',
      },
      verify: {
        commands: [
          "julia -e 'Base.find_package(\"Pluto\") |> isnothing && exit(1)'",
        ],
      },
    },
    {
      id: "rserver",
      title: "RStudio Server",
      short_label: "RStudio / rserver",
      category: "core",
      priority: 80,
      homepage: "https://posit.co/products/open-source/rstudio-server/",
      description: "Browser IDE for R and data science workflows.",
      detect: {
        commands: ["command -v rserver"],
      },
      install: {
        strategy: "agent",
        hint: "RStudio Server installation is more system-specific. Let an agent set it up or follow your platform packaging workflow.",
        agent_prompt:
          "Set up RStudio Server (rserver) in the current Linux project or host environment so the managed app can start. Choose an approach appropriate for this system, verify 'rserver --version' if possible, and explain any limitations.",
      },
      preset: {
        id: "rserver",
        title: "RStudio Server",
        kind: "service",
        preferred_port: "6006",
        service_open_mode: "proxy",
        command:
          "rserver --server-daemonize=0 --auth-none=1 --auth-encrypt-password=0 --www-port=${PORT} --www-root-path=${APP_BASE_URL} --auth-minimum-user-id=0",
      },
    },
    {
      id: "python-hello",
      title: "Python Hello World",
      category: "core",
      priority: 40,
      description:
        "Minimal HTTP hello-world app for testing the managed app flow.",
      detect: {
        commands: ["command -v python3"],
      },
      preset: {
        id: "python-hello",
        title: "Python Hello World",
        kind: "service",
        preferred_port: "8080",
        service_open_mode: "proxy",
        health_path: "/",
        command:
          "python3 -c \"import os, pathlib, http.server; host=os.getenv('HOST','127.0.0.1'); port=int(os.getenv('PORT','8080')); root=pathlib.Path('/tmp/cocalc-python-hello'); root.mkdir(parents=True, exist_ok=True); (root/'index.html').write_text('<h1>Hello from Python</h1>\\\\n', encoding='utf-8'); os.chdir(root); server=http.server.ThreadingHTTPServer((host,port), http.server.SimpleHTTPRequestHandler); print(f'listening on http://{host}:{port}', flush=True); server.serve_forever()\"",
      },
    },
    {
      id: "node-hello",
      title: "Node.js Hello World",
      category: "core",
      priority: 35,
      description: "Minimal Node HTTP app for testing the managed app flow.",
      detect: {
        commands: ["command -v node"],
      },
      preset: {
        id: "node-hello",
        title: "Node.js Hello World",
        kind: "service",
        preferred_port: "8080",
        service_open_mode: "proxy",
        command:
          "node -e \"const http=require('http');const host=process.env.HOST||'127.0.0.1';const port=Number(process.env.PORT||8080);http.createServer((req,res)=>{const body='hello from node\\\\n';res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-length':Buffer.byteLength(body)});res.end(body);}).listen(port,host,()=>console.log('listening on http://'+host+':'+port));\"",
      },
    },
    {
      id: "static-hello",
      title: "Static Hello World",
      category: "core",
      priority: 30,
      description:
        "Minimal static site example with optional refresh/bootstrap logic.",
      preset: {
        id: "static-hello",
        title: "Static Hello World",
        kind: "static",
        static_root_relative: "static-hello",
        static_index: "index.html",
        static_cache_control: "public,max-age=3600",
        static_refresh_command: `mkdir -p "$APP_STATIC_ROOT" && [ -f "$APP_STATIC_ROOT/index.html" ] || printf '<h1>Hello from static app</h1>\\n' > "$APP_STATIC_ROOT/index.html"`,
        static_refresh_stale_after: "3600",
        static_refresh_timeout: "120",
        static_refresh_on_hit: true,
        note: "Optional refresh job can bootstrap or periodically update generated static content on first/stale hits.",
      },
    },
  ],
};

export default BUILTIN_APP_TEMPLATE_CATALOG;
