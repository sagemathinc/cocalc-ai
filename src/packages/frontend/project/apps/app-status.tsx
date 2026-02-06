import { Alert } from "antd";
import { capitalize } from "@cocalc/util/misc";
import ShowError from "@cocalc/frontend/components/error";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";

const INSTALL_HINTS: Record<
  string,
  { title: string; commands?: string[]; note?: string }
> = {
  jupyterlab: {
    title: "Install JupyterLab",
    commands: ["python3 -m pip install --user jupyterlab"],
  },
  jupyter: {
    title: "Install Jupyter Classic",
    commands: ["python3 -m pip install --user notebook"],
  },
  code: {
    title: "Install VS Code (code-server)",
    commands: ["curl -fsSL https://code-server.dev/install.sh | sh"],
  },
  pluto: {
    title: "Install Pluto.jl",
    commands: ['julia -e \'import Pkg; Pkg.add("Pluto")\''],
    note: "Requires Julia to be installed.",
  },
  rserver: {
    title: "Install R IDE Server",
    note:
      "R IDE requires the rserver binary (Posit/RStudio Server). Ask an administrator to install it.",
  },
};

export default function AppStatus({
  status,
  name,
}: {
  status: any;
  name?: string;
}) {
  const { stdout, stderr, state, cmd, args, pid, url, spawnError, exit } =
    status;
  const output =
    stdout != null && stderr != null
      ? Buffer.from(stdout).toString().trim() +
        "\n\n" +
        Buffer.from(stderr).toString().trim()
      : "";
  const hint = name ? INSTALL_HINTS[name] : undefined;
  return (
    <div>
      <h3>{capitalize(state)}</h3>
      {spawnError && hint && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: "10px" }}
          title={hint.title}
          description={
            <div>
              {hint.note ? <div style={{ marginBottom: "6px" }}>{hint.note}</div> : null}
              {hint.commands && hint.commands.length > 0 ? (
                <StaticMarkdown
                  value={`\`\`\`sh\n${hint.commands.join("\n")}\n\`\`\``}
                />
              ) : null}
            </div>
          }
        />
      )}
      {spawnError && (
        <ShowError
          error={
            `Unable to run '${cmd}' -- probably not installed\n\n` +
            "```js\n" +
            JSON.stringify(spawnError, undefined, 2) +
            "\n```"
          }
        />
      )}
      <pre>{JSON.stringify({ pid, url, exit }, undefined, 2)}</pre>
      {cmd && (
        <StaticMarkdown value={"```sh\n" + toShell(cmd, args) + "\n```"} />
      )}
      <pre style={{ maxHeight: "300px" }}>{output}</pre>
    </div>
  );
}

function toShell(cmd, args?: string[]) {
  let s = cmd;
  if (args == null || args.length == 0) {
    return s;
  }
  return s + " " + args.map((x) => (x.includes(" ") ? `"${x}"` : x)).join(" ");
}
