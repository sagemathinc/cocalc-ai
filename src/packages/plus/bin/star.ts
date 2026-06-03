#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { Command } from "commander";
import {
  buildSshArgs,
  canBindPort,
  collectRepeatable,
  openUrl,
  parseTarget,
  pickFreePort,
  sshRunAsync,
  type SshOptions,
} from "../ssh/core";

const DEFAULT_INSTALLER_URL =
  "https://github.com/sagemathinc/cocalc-ai/releases/latest/download/install-cocalc-star.sh";
const STAR_REMOTE_PORT = 9100;

type StarCliOptions = {
  installerUrl?: string;
  localPort?: string;
  noInstall?: boolean;
  noOpen?: boolean;
  upgrade?: boolean;
  statusOnly?: boolean;
  identity?: string;
  proxyJump?: string;
  sshArg?: string[];
};

type CommanderStarOptions = StarCliOptions & {
  install?: boolean;
  open?: boolean;
};

type RemoteStarStatus = {
  installed: boolean;
  hub: string;
  projectHost: string;
  release: string;
  bootstrapUrl: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseStatusLine(line: string): [string, string] | null {
  const idx = line.indexOf("=");
  if (idx <= 0) return null;
  return [line.slice(0, idx), line.slice(idx + 1)];
}

function parseRemoteStatus(raw: string): RemoteStarStatus {
  const data: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const entry = parseStatusLine(line.trim());
    if (!entry) continue;
    data[entry[0]] = entry[1];
  }
  return {
    installed: data.installed === "1",
    hub: data.hub || "unknown",
    projectHost: data.project_host || "unknown",
    release: data.release || "",
    bootstrapUrl: data.bootstrap_url || "",
  };
}

async function getRemoteStarStatus(
  sshOpts: SshOptions,
): Promise<RemoteStarStatus> {
  const script = String.raw`
set -eu
star=/opt/cocalc-star/source/src/scripts/star/star.sh
if [ ! -x "$star" ]; then
  printf 'installed=0\nhub=missing\nproject_host=missing\nrelease=\nbootstrap_url=\n'
  exit 0
fi
printf 'installed=1\n'
printf 'hub=%s\n' "$(systemctl is-active cocalc-star-hub 2>/dev/null || true)"
printf 'project_host=%s\n' "$(systemctl is-active cocalc-star-project-host 2>/dev/null || true)"
printf 'release=%s\n' "$(sudo -n "$star" current-release 2>/dev/null || true)"
if [ -f /var/lib/cocalc/star/bootstrap-result.json ]; then
  printf 'bootstrap_url=%s\n' "$(sudo -n sed -n 's/.*"bootstrap_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /var/lib/cocalc/star/bootstrap-result.json 2>/dev/null || true)"
else
  printf 'bootstrap_url=\n'
fi
`;
  const res = await sshRunAsync(sshOpts, `bash -lc ${shellQuote(script)}`, {
    timeoutMs: 15000,
  });
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`remote Star status failed: ${res.stderr || res.status}`);
  }
  return parseRemoteStatus(res.stdout);
}

function localBootstrapUrl(remoteBootstrapUrl: string, localPort: number) {
  if (!remoteBootstrapUrl) {
    return `http://127.0.0.1:${localPort}/`;
  }
  try {
    const url = new URL(remoteBootstrapUrl);
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = String(localPort);
    return url.toString();
  } catch {
    return `http://127.0.0.1:${localPort}/`;
  }
}

async function chooseLocalPort(raw?: string): Promise<number> {
  if (!raw || raw === "auto") {
    if (await canBindPort(STAR_REMOTE_PORT)) {
      return STAR_REMOTE_PORT;
    }
    return await pickFreePort();
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --local-port '${raw}'`);
  }
  if (!(await canBindPort(port))) {
    throw new Error(`local port ${port} is already in use`);
  }
  return port;
}

async function installRemoteStar(
  target: string,
  sshOpts: SshOptions,
  installerUrl: string,
) {
  const install = [
    `curl -fsSL ${shellQuote(installerUrl)}`,
    `| sudo STAR_ASSUME_YES=1 STAR_SSH_TARGET=${shellQuote(target)} bash`,
  ].join(" ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "ssh",
      buildSshArgs(sshOpts).concat(sshOpts.host, install),
      {
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`remote Star install terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`remote Star install exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

function startTunnel(
  target: string,
  sshOpts: SshOptions,
  localPort: number,
): ChildProcess {
  const tunnelArgs = buildSshArgs(sshOpts).concat([
    "-N",
    "-L",
    `${localPort}:127.0.0.1:${STAR_REMOTE_PORT}`,
    sshOpts.host,
  ]);
  console.log(
    `Forwarding http://127.0.0.1:${localPort} -> ${target}:127.0.0.1:${STAR_REMOTE_PORT}`,
  );
  return spawn("ssh", tunnelArgs, { stdio: "inherit" });
}

function printStatus(status: RemoteStarStatus) {
  if (!status.installed) {
    console.log("CoCalc Star: not installed");
    return;
  }
  console.log("CoCalc Star: installed");
  console.log(`Hub service: ${status.hub}`);
  console.log(`Project-host service: ${status.projectHost}`);
  if (status.release) {
    console.log(`Release: ${status.release}`);
  }
  if (status.bootstrapUrl) {
    console.log("Bootstrap URL is still available.");
  }
}

async function connectStar(target: string, options: StarCliOptions) {
  const { host, port } = parseTarget(target);
  const sshOpts: SshOptions = {
    host,
    port,
    identity: options.identity,
    proxyJump: options.proxyJump,
    sshArgs: options.sshArg || [],
  };
  const installerUrl = options.installerUrl || DEFAULT_INSTALLER_URL;

  let status = await getRemoteStarStatus(sshOpts);
  if (options.statusOnly) {
    printStatus(status);
    return;
  }
  if (
    (!status.installed && options.noInstall) ||
    (status.installed && !options.upgrade)
  ) {
    if (!status.installed) {
      throw new Error("CoCalc Star is not installed on the remote target");
    }
  } else {
    if (status.installed && options.upgrade) {
      console.log("Upgrading CoCalc Star on remote target...");
    } else {
      console.log("Installing CoCalc Star on remote target...");
    }
    await installRemoteStar(target, sshOpts, installerUrl);
    status = await getRemoteStarStatus(sshOpts);
  }

  if (!status.installed) {
    throw new Error("CoCalc Star did not appear after install");
  }

  printStatus(status);
  const localPort = await chooseLocalPort(options.localPort);
  const url = localBootstrapUrl(status.bootstrapUrl, localPort);
  const tunnel = startTunnel(target, sshOpts, localPort);

  console.log("");
  console.log("Open this URL on your laptop:");
  console.log(`  ${url}`);
  if (!options.noOpen) {
    openUrl(url);
  }
  tunnel.on("exit", (code) => process.exit(code ?? 0));
}

function normalizeOptions(options: CommanderStarOptions): StarCliOptions {
  return {
    ...options,
    noInstall: options.noInstall || options.install === false,
    noOpen: options.noOpen || options.open === false,
  };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const program = new Command();
  program
    .name("cocalc-plus star")
    .usage("user@host[:port] [options]")
    .showHelpAfterError()
    .argument("[target]")
    .option("--target <target>", "disambiguate targets named status")
    .option(
      "--installer-url <url>",
      "Star installer URL",
      DEFAULT_INSTALLER_URL,
    )
    .option("--local-port <n|auto>", "local forwarded port", "9100")
    .option("--no-install", "fail instead of installing Star when missing")
    .option("--no-open", "do not try to open the browser")
    .option(
      "--upgrade",
      "run the installer even when Star is already installed",
    )
    .option("--status-only", "show remote Star status and exit")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .addHelpText(
      "after",
      `\nExamples:\n  cocalc-plus star ubuntu@1.2.3.4\n  cocalc-plus star ubuntu@1.2.3.4 --local-port 9500 --no-open\n  cocalc-plus star ubuntu@1.2.3.4 --status-only\n  cocalc-plus star ubuntu@1.2.3.4 --identity ~/.ssh/id_ed25519\n`,
    )
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.help({ error: true });
        return;
      }
      await connectStar(finalTarget, normalizeOptions(options));
    });

  program
    .command("status")
    .argument("[target]")
    .option("--target <target>")
    .option("--ssh-arg <arg>", "(repeatable)", collectRepeatable, [])
    .option("--identity <file>")
    .option("--proxy-jump <host>")
    .action(async (target: string | undefined, options) => {
      const finalTarget = options.target ?? target;
      if (!finalTarget) {
        program.error("Missing target for status.");
        return;
      }
      const { host, port } = parseTarget(finalTarget);
      const sshOpts: SshOptions = {
        host,
        port,
        identity: options.identity,
        proxyJump: options.proxyJump,
        sshArgs: options.sshArg || [],
      };
      printStatus(await getRemoteStarStatus(sshOpts));
    });

  await program.parseAsync(argv, { from: "user" });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("cocalc-plus star failed:", err?.message || err);
    process.exit(1);
  });
}
