/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "../theme";
import type { AppTemplateCatalogV1 } from "./template-catalog";

const CORE_TEMPLATE_THEME = {
  accent_color: COLORS.BLUE_D,
  surface_color: COLORS.BLUE_LLLL,
} as const;

const PYTHON_WEB_TEMPLATE_THEME = {
  accent_color: COLORS.BS_GREEN_D,
  surface_color: COLORS.BS_GREEN_LL,
} as const;

const PYTHON_NOTEBOOK_TEMPLATE_THEME = {
  accent_color: COLORS.COCALC_ORANGE,
  surface_color: COLORS.YELL_LLL,
} as const;

const DOCS_TEMPLATE_THEME = {
  accent_color: COLORS.BLUE_DOC,
  surface_color: COLORS.BLUE_LLLL,
} as const;

const PUBLISHING_TEMPLATE_THEME = {
  accent_color: COLORS.BRWN,
  surface_color: COLORS.YELL_LLL,
} as const;

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeTemplateHero(
  title: string,
  subtitle: string,
  accent: string,
  surface: string,
): string {
  return svgDataUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 240" role="img" aria-label="${title}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${surface}" />
      <stop offset="100%" stop-color="white" />
    </linearGradient>
  </defs>
  <rect width="520" height="240" rx="28" fill="url(#bg)" />
  <circle cx="410" cy="58" r="82" fill="${accent}" fill-opacity="0.16" />
  <circle cx="468" cy="198" r="118" fill="${accent}" fill-opacity="0.10" />
  <rect x="28" y="30" width="110" height="12" rx="6" fill="${accent}" fill-opacity="0.22" />
  <rect x="28" y="54" width="74" height="12" rx="6" fill="${accent}" fill-opacity="0.14" />
  <text x="28" y="126" font-family="system-ui, sans-serif" font-size="38" font-weight="700" fill="${COLORS.GRAY_DD}">${title}</text>
  <text x="28" y="164" font-family="system-ui, sans-serif" font-size="21" fill="${COLORS.GRAY_M}">${subtitle}</text>
</svg>`);
}

function withTemplateTheme(
  icon: string,
  theme: { accent_color: string; surface_color: string },
  title: string,
  subtitle: string,
) {
  return {
    icon,
    ...theme,
    hero_image: makeTemplateHero(
      title,
      subtitle,
      theme.accent_color,
      theme.surface_color,
    ),
  };
}

export const BUILTIN_APP_TEMPLATE_CATALOG: AppTemplateCatalogV1 = {
  version: 1,
  kind: "cocalc-app-template-catalog",
  source: "builtin",
  published_at: "2026-03-20T00:00:00.000Z",
  templates: [
    {
      id: "jupyterlab",
      title: "JupyterLab",
      category: "core",
      priority: 100,
      homepage: "https://jupyter.org/",
      description: "Interactive notebooks, terminals, and files.",
      theme: withTemplateTheme(
        "ipynb",
        CORE_TEMPLATE_THEME,
        "JupyterLab",
        "Notebooks + terminals",
      ),
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
      theme: withTemplateTheme(
        "vscode",
        CORE_TEMPLATE_THEME,
        "VS Code",
        "Editor in the browser",
      ),
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
      theme: withTemplateTheme(
        "julia",
        CORE_TEMPLATE_THEME,
        "Pluto",
        "Reactive Julia notebooks",
      ),
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
      theme: withTemplateTheme(
        "r",
        CORE_TEMPLATE_THEME,
        "RStudio",
        "R IDE and data workflows",
      ),
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
      id: "streamlit",
      title: "Streamlit",
      category: "python-web",
      priority: 78,
      homepage: "https://streamlit.io/",
      description: "Interactive Python dashboards and data apps.",
      theme: withTemplateTheme(
        "dashboard",
        PYTHON_WEB_TEMPLATE_THEME,
        "Streamlit",
        "Data apps and dashboards",
      ),
      detect: {
        commands: ["python3 -m streamlit version"],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed streamlit",
        hint: "Installs Streamlit systemwide in the project and uses a small bootstrap streamlit_app.py if the project does not already have one.",
        agent_prompt:
          "Install Streamlit in the current project so the managed Streamlit app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with 'python3 -m streamlit version', and mention that the managed template bootstraps streamlit_app.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-streamlit",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed streamlit",
            ],
            notes:
              "The managed Streamlit template can create a default streamlit_app.py automatically if the project is empty.",
          },
        ],
      },
      preset: {
        id: "streamlit",
        title: "Streamlit",
        kind: "service",
        preferred_port: "6010",
        service_open_mode: "proxy",
        command: `app=\${APP_START_FILE:-streamlit_app.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
import streamlit as st

st.set_page_config(page_title="Streamlit on CoCalc")
st.title("Streamlit on CoCalc")
st.write("Edit app.py to replace this demo.")
st.line_chart({"demo": [1, 3, 2, 4]})
PY
fi
exec python3 -m streamlit run "$app" --server.address="\${HOST:-127.0.0.1}" --server.port="\${PORT}" --server.headless=true --server.baseUrlPath="\${APP_BASE_URL#/}" --browser.gatherUsageStats=false`,
      },
      verify: {
        commands: ["python3 -m streamlit version"],
      },
      agent_prompt_seed:
        "Prefer the direct python3-pip install path for Streamlit, and do not overcomplicate the bootstrap: the managed app template will create streamlit_app.py if needed.",
    },
    {
      id: "fastapi",
      title: "FastAPI",
      category: "python-web",
      priority: 74,
      homepage: "https://fastapi.tiangolo.com/",
      description: "Fast Python APIs served with Uvicorn.",
      theme: withTemplateTheme(
        "rocket",
        PYTHON_WEB_TEMPLATE_THEME,
        "FastAPI",
        "Modern Python APIs",
      ),
      detect: {
        commands: [
          `python3 -c "import fastapi, uvicorn; print(fastapi.__version__)"`,
        ],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed fastapi uvicorn[standard]",
        hint: "Installs FastAPI plus Uvicorn and bootstraps main.py if the project does not already have one.",
        agent_prompt:
          "Install FastAPI and uvicorn in the current project so the managed FastAPI app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify imports for both fastapi and uvicorn, and mention that the managed template bootstraps main.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-fastapi",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed fastapi uvicorn[standard]",
            ],
            notes:
              "The managed FastAPI template expects main:app by default and will create main.py automatically if it is missing.",
          },
        ],
      },
      preset: {
        id: "fastapi",
        title: "FastAPI",
        kind: "service",
        preferred_port: "6011",
        service_open_mode: "proxy",
        health_path: "/",
        command: `app=\${APP_START_FILE:-main.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
from fastapi import FastAPI

app = FastAPI(title="FastAPI on CoCalc")


@app.get("/")
def root():
    return {"ok": True, "message": "Edit main.py to replace this demo."}
PY
fi
exec python3 -m uvicorn "\${APP_MODULE:-main:app}" --host "\${HOST:-127.0.0.1}" --port "\${PORT}" --proxy-headers --forwarded-allow-ips='*'`,
      },
      verify: {
        commands: [
          `python3 -c "import fastapi, uvicorn; print(fastapi.__version__)"`,
        ],
      },
    },
    {
      id: "flask",
      title: "Flask",
      category: "python-web",
      priority: 72,
      homepage: "https://flask.palletsprojects.com/",
      description: "Minimal Python web apps and APIs.",
      theme: withTemplateTheme(
        "api",
        PYTHON_WEB_TEMPLATE_THEME,
        "Flask",
        "Minimal Python services",
      ),
      detect: {
        commands: [`python3 -c "import flask; print(flask.__version__)"`],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed flask",
        hint: "Installs Flask and bootstraps flask_app.py if the project does not already have one.",
        agent_prompt:
          "Install Flask in the current project so the managed Flask app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with a Python import/version check, and mention that the managed template bootstraps flask_app.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-flask",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed flask",
            ],
          },
        ],
      },
      preset: {
        id: "flask",
        title: "Flask",
        kind: "service",
        preferred_port: "6012",
        service_open_mode: "proxy",
        command: `app=\${APP_START_FILE:-flask_app.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
from flask import Flask

app = Flask(__name__)


@app.get("/")
def index():
    return "<h1>Flask on CoCalc</h1><p>Edit app.py to replace this demo.</p>"
PY
fi
export FLASK_APP="\${FLASK_APP:-$app}"
export FLASK_DEBUG=0
exec python3 -m flask run --host="\${HOST:-127.0.0.1}" --port="\${PORT}"`,
      },
      verify: {
        commands: [`python3 -c "import flask; print(flask.__version__)"`],
      },
    },
    {
      id: "gradio",
      title: "Gradio",
      category: "python-web",
      priority: 70,
      homepage: "https://www.gradio.app/",
      description: "Quick browser UIs for Python functions and ML demos.",
      theme: withTemplateTheme(
        "robot",
        PYTHON_WEB_TEMPLATE_THEME,
        "Gradio",
        "Browser UIs for Python",
      ),
      detect: {
        commands: [`python3 -c "import gradio; print(gradio.__version__)"`],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed gradio",
        hint: "Installs Gradio and bootstraps gradio_app.py if the project does not already have one.",
        agent_prompt:
          "Install Gradio in the current project so the managed Gradio app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with a Python import/version check, and mention that the managed template bootstraps gradio_app.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-gradio",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed gradio",
            ],
          },
        ],
      },
      preset: {
        id: "gradio",
        title: "Gradio",
        kind: "service",
        preferred_port: "6013",
        service_open_mode: "proxy",
        command: `app=\${APP_START_FILE:-gradio_app.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
import os
import gradio as gr


def greet(name: str) -> str:
    return f"Hello, {name or 'world'}!"


demo = gr.Interface(
    fn=greet,
    inputs="text",
    outputs="text",
    title="Gradio on CoCalc",
    description="Edit app.py to replace this demo.",
)


if __name__ == "__main__":
    demo.launch(
        server_name=os.environ.get("HOST", "127.0.0.1"),
        server_port=int(os.environ["PORT"]),
        share=False,
        root_path=os.environ.get("APP_BASE_URL", "/"),
    )
PY
fi
exec python3 "$app"`,
      },
      verify: {
        commands: [`python3 -c "import gradio; print(gradio.__version__)"`],
      },
    },
    {
      id: "dash",
      title: "Dash",
      category: "python-web",
      priority: 68,
      homepage: "https://dash.plotly.com/",
      description: "Interactive analytic dashboards with Plotly Dash.",
      theme: withTemplateTheme(
        "line-chart",
        PYTHON_WEB_TEMPLATE_THEME,
        "Dash",
        "Interactive analytics",
      ),
      detect: {
        commands: [`python3 -c "import dash; print(dash.__version__)"`],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed dash",
        hint: "Installs Dash and bootstraps dash_app.py if the project does not already have one.",
        agent_prompt:
          "Install Plotly Dash in the current project so the managed Dash app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with a Python import/version check, and mention that the managed template bootstraps dash_app.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-dash",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed dash",
            ],
          },
        ],
      },
      preset: {
        id: "dash",
        title: "Dash",
        kind: "service",
        preferred_port: "6014",
        service_open_mode: "proxy",
        command: `app=\${APP_START_FILE:-dash_app.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
import os
from dash import Dash, dcc, html


base = os.environ.get("APP_BASE_URL", "/")
if not base.endswith("/"):
    base = f"{base}/"

app = Dash(
    __name__,
    requests_pathname_prefix=base,
    routes_pathname_prefix=base,
)
server = app.server
app.layout = html.Div(
    [
        html.H1("Dash on CoCalc"),
        html.P("Edit app.py to replace this demo."),
        dcc.Graph(
            figure={
                "data": [{"x": [1, 2, 3], "y": [1, 4, 2], "type": "line"}],
                "layout": {"margin": {"l": 30, "r": 10, "t": 30, "b": 30}},
            }
        ),
    ],
    style={"maxWidth": "960px", "margin": "0 auto"},
)


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ["PORT"]), debug=False)
PY
fi
exec python3 "$app"`,
      },
      verify: {
        commands: [`python3 -c "import dash; print(dash.__version__)"`],
      },
    },
    {
      id: "mkdocs",
      title: "MkDocs",
      category: "docs",
      priority: 60,
      homepage: "https://www.mkdocs.org/",
      description:
        "Documentation sites from Markdown, served live in the browser.",
      theme: withTemplateTheme(
        "book",
        DOCS_TEMPLATE_THEME,
        "MkDocs",
        "Live docs from Markdown",
      ),
      detect: {
        commands: ["python3 -m mkdocs --version"],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed mkdocs mkdocs-material",
        hint: "Installs MkDocs plus the Material theme and bootstraps mkdocs.yml and docs/index.md if the project does not already have them.",
        agent_prompt:
          "Install MkDocs in the current project so the managed MkDocs app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with 'python3 -m mkdocs --version', and mention that the managed template bootstraps mkdocs.yml and docs/index.md if missing.",
        recipes: [
          {
            id: "ubuntu-pip-mkdocs",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed mkdocs mkdocs-material",
            ],
          },
        ],
      },
      preset: {
        id: "mkdocs",
        title: "MkDocs",
        kind: "service",
        preferred_port: "6015",
        service_open_mode: "proxy",
        command: `if [ ! -f mkdocs.yml ]; then
  mkdir -p docs
  cat > mkdocs.yml <<'YML'
site_name: CoCalc MkDocs Site
theme:
  name: material
nav:
  - Home: index.md
YML
fi
if [ ! -f docs/index.md ]; then
  mkdir -p docs
  cat > docs/index.md <<'MD'
# MkDocs on CoCalc

Edit docs/index.md to replace this demo.
MD
fi
exec python3 -m mkdocs serve --dev-addr "\${HOST:-127.0.0.1}:\${PORT}"`,
      },
      verify: {
        commands: ["python3 -m mkdocs --version"],
      },
    },
    {
      id: "marimo",
      title: "marimo",
      category: "python-notebooks",
      priority: 76,
      homepage: "https://marimo.io/",
      description:
        "Reactive Python notebooks and apps in a lightweight editor.",
      theme: withTemplateTheme(
        "edit",
        PYTHON_NOTEBOOK_TEMPLATE_THEME,
        "marimo",
        "Reactive Python notebooks",
      ),
      detect: {
        commands: ["python3 -m marimo --version"],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed marimo",
        hint: "Installs marimo and bootstraps marimo_app.py if the project does not already have one.",
        agent_prompt:
          "Install marimo in the current project so the managed marimo app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with 'python3 -m marimo --version', and mention that the managed template bootstraps marimo_app.py if missing.",
        recipes: [
          {
            id: "ubuntu-pip-marimo",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed marimo",
            ],
            notes:
              "The managed marimo template creates marimo_app.py automatically if the project is empty.",
          },
        ],
      },
      preset: {
        id: "marimo",
        title: "marimo",
        kind: "service",
        preferred_port: "6016",
        service_open_mode: "port",
        command: `app=\${APP_START_FILE:-marimo_app.py}; if [ ! -f "$app" ]; then cat > "$app" <<'PY'
import marimo

__generated_with = "0.0.0"
app = marimo.App(width="medium")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.md("# marimo on CoCalc\\n\\nEdit marimo_app.py to replace this demo.")
    return


if __name__ == "__main__":
    app.run()
PY
fi
base_url="\${APP_BASE_URL/\\/proxy\\//\\/port\\/}"
base_url="\${base_url%/}"
exec python3 -m marimo edit --headless --no-token --base-url "\${base_url}" --host "\${HOST:-127.0.0.1}" --port "\${PORT}" "$app"`,
      },
      verify: {
        commands: ["python3 -m marimo --version"],
      },
      agent_prompt_seed:
        "marimo is a good fit for reactive Python notebooks. Keep the install simple with python3 -m pip and rely on the managed template bootstrap for marimo_app.py.",
    },
    {
      id: "voila",
      title: "Voilà",
      category: "python-notebooks",
      priority: 67,
      homepage: "https://voila.readthedocs.io/",
      description:
        "Turn Jupyter notebooks into standalone dashboards and apps.",
      theme: withTemplateTheme(
        "project",
        PYTHON_NOTEBOOK_TEMPLATE_THEME,
        "Voila",
        "Notebook-powered apps",
      ),
      detect: {
        commands: ["python3 -m voila --version"],
      },
      install: {
        strategy: "curated",
        command:
          "apt-get update && apt-get install -y python3-pip && python3 -m pip install --break-system-packages --ignore-installed voila ipywidgets",
        hint: "Installs Voilà plus ipywidgets and bootstraps voila_app.ipynb if the project does not already have one.",
        agent_prompt:
          "Install Voilà in the current project so the managed Voilà app can start. Use python3 -m pip with --break-system-packages --ignore-installed after ensuring python3-pip is installed, verify the runtime with 'python3 -m voila --version', and mention that the managed template bootstraps voila_app.ipynb if missing.",
        recipes: [
          {
            id: "ubuntu-pip-voila",
            match: { os_family: ["debian", "ubuntu"] },
            commands: [
              "apt-get update",
              "apt-get install -y python3-pip",
              "python3 -m pip install --break-system-packages --ignore-installed voila ipywidgets",
            ],
            notes:
              "The managed Voilà template creates voila_app.ipynb automatically if the project is empty.",
          },
        ],
      },
      preset: {
        id: "voila",
        title: "Voilà",
        kind: "service",
        preferred_port: "6017",
        service_open_mode: "proxy",
        health_path: "/",
        command: `app=\${APP_START_FILE:-voila_app.ipynb}; if [ ! -f "$app" ]; then cat > "$app" <<'JSON'
{
  "cells": [
    {
      "cell_type": "markdown",
      "id": "intro",
      "metadata": {},
      "source": [
        "# Voilà on CoCalc\\n",
        "\\n",
        "Edit voila_app.ipynb to replace this demo."
      ]
    },
    {
      "cell_type": "code",
      "id": "demo",
      "execution_count": null,
      "metadata": {},
      "outputs": [],
      "source": [
        "from IPython.display import HTML\\n",
        "HTML('<p>This notebook is ready for Voilà.</p>')\\n"
      ]
    }
  ],
  "metadata": {
    "kernelspec": {
      "display_name": "Python 3",
      "language": "python",
      "name": "python3"
    },
    "language_info": {
      "name": "python"
    }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
JSON
fi
exec python3 -m voila "$app" --no-browser --Voila.ip="\${HOST:-127.0.0.1}" --port="\${PORT}" --Voila.base_url="\${APP_BASE_URL}"`,
      },
      verify: {
        commands: ["python3 -m voila --version"],
      },
      agent_prompt_seed:
        "Prefer the standard Voilà CLI. The managed template can bootstrap a simple voila_app.ipynb, so installation should focus on the runtime and widgets support.",
    },
    {
      id: "quarto",
      title: "Quarto",
      category: "publishing",
      priority: 64,
      homepage: "https://quarto.org/",
      description:
        "Technical publishing for notebooks, docs, presentations, and sites.",
      theme: withTemplateTheme(
        "layout",
        PUBLISHING_TEMPLATE_THEME,
        "Quarto",
        "Publishing and reports",
      ),
      detect: {
        commands: [
          `bash -lc 'command -v quarto >/dev/null 2>&1 && quarto --version || /opt/quarto/bin/quarto --version'`,
        ],
      },
      install: {
        strategy: "agent",
        hint: "Quarto installation is more platform-specific than the pip-based Python templates. Let an agent install it or use your platform packaging workflow.",
        agent_prompt:
          "Install Quarto in the current project so the managed Quarto app can start. Choose a safe Linux installation path for this system, verify 'quarto --version', and explain any additional runtime assumptions such as Pandoc, TeX, or Jupyter integration.",
      },
      preset: {
        id: "quarto",
        title: "Quarto",
        kind: "service",
        preferred_port: "6018",
        service_open_mode: "proxy",
        command: `quarto_bin="\${QUARTO_BIN:-}"; if [ -z "$quarto_bin" ] && command -v quarto >/dev/null 2>&1; then quarto_bin="$(command -v quarto)"; fi; if [ -z "$quarto_bin" ] && [ -x /opt/quarto/bin/quarto ]; then quarto_bin=/opt/quarto/bin/quarto; fi; if [ -z "$quarto_bin" ]; then echo "quarto not found; install Quarto or set QUARTO_BIN" >&2; exit 127; fi; if [ ! -f index.qmd ]; then
  cat > index.qmd <<'QMD'
---
title: "Quarto on CoCalc"
format: html
---

# Quarto on CoCalc

Edit index.qmd to replace this demo.
QMD
fi
exec "$quarto_bin" preview index.qmd --no-browser --host "\${HOST:-127.0.0.1}" --port "\${PORT}"`,
      },
      verify: {
        commands: [
          `bash -lc 'command -v quarto >/dev/null 2>&1 && quarto --version || /opt/quarto/bin/quarto --version'`,
        ],
      },
      agent_prompt_seed:
        "Quarto is worth offering even though install is heavier. Prefer a straightforward verified install and let the managed template bootstrap index.qmd if needed.",
    },
    {
      id: "python-hello",
      title: "Python Hello World",
      category: "core",
      priority: 40,
      description:
        "Minimal HTTP hello-world app for testing the managed app flow.",
      theme: withTemplateTheme(
        "code",
        CORE_TEMPLATE_THEME,
        "Python",
        "Minimal HTTP demo",
      ),
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
      theme: withTemplateTheme(
        "api",
        CORE_TEMPLATE_THEME,
        "Node.js",
        "Minimal HTTP demo",
      ),
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
      theme: withTemplateTheme(
        "html5",
        PUBLISHING_TEMPLATE_THEME,
        "Static site",
        "Generated or hand-written",
      ),
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
