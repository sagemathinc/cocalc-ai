import { CodeBlock, DSProvider } from "@cocalc/frontend";

// CodeBlock — the monospace command/snippet block with a copy button, used on
// API / install / CLI pages. `code` is required (whitespace-preserving);
// `ariaLabel` defaults to "Code example". DSProvider supplies the antd App the
// copy button reads from context. Snippets are the real ones from the pages.

export const ApiCall = () => (
  <DSProvider>
    <CodeBlock
      ariaLabel="Example API call"
      code={`curl -u "$COCALC_API_KEY:" \\
  https://cocalc.ai/api/v2/exec \\
  -d '{"project_id": "...", "command": "python3", "args": ["analysis.py"]}'`}
    />
  </DSProvider>
);

export const InstallCommand = () => (
  <DSProvider>
    <CodeBlock
      ariaLabel="Install command"
      code="curl -fsSL https://github.com/sagemathinc/cocalc-ai/releases/download/cocalc-star-stable/install-cocalc-star.sh | sudo bash"
    />
  </DSProvider>
);

export const JupyterCommands = () => (
  <DSProvider>
    <CodeBlock
      ariaLabel="Project-scoped Jupyter commands"
      code={`cocalc project jupyter cells --path analysis.ipynb
cocalc project jupyter run --path analysis.ipynb --cell-index 3
cocalc project jupyter exec --path analysis.ipynb --stdin`}
    />
  </DSProvider>
);

export const DefaultAriaLabel = () => (
  <DSProvider>
    <CodeBlock code="curl -fsSL https://software.cocalc.ai/software/cocalc-launchpad/install.sh | bash" />
  </DSProvider>
);
