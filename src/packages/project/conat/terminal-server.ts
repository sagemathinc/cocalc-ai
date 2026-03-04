import { terminalServer, type Options } from "@cocalc/conat/project/terminal";
import { spawn } from "node-pty";
import { getIdentity } from "./connection";
import { getLogger } from "@cocalc/project/logger";
import { SpoolWatcher } from "@cocalc/backend/spool-watcher";
import { data } from "@cocalc/backend/data";
import { randomId } from "@cocalc/conat/names";
import { join } from "path";
import { debounce } from "lodash";
import { getOwnedProcessRegistry } from "@cocalc/project/project-info";
import {
  supportsTerminalCwdLookup,
  terminalCwdForPid,
} from "./terminal/cwd";

const logger = getLogger("project:conat:terminal-server");

export function init(opts) {
  opts = getIdentity(opts);
  logger.debug("init");
  terminalServer({
    ...opts,
    spawn,
    cwd: terminalCwdForPid,
    preHook,
    postHook,
  });
}

async function preHook({ options }: { options: Options }) {
  if (options.env0) {
    for (const key in options.env0) {
      options.env0[key] = options.env0[key].replace(
        /\$HOME/g,
        process.env.HOME ?? "",
      );
    }
  }
  if (options.env0?.COCALC_CONTROL_DIR != null) {
    options.env0.COCALC_CONTROL_DIR = join(data, "terminal", randomId());
  }
  return options;
}

async function postHook({ options, pty }) {
  const registry = getOwnedProcessRegistry();
  const root = registry.registerRoot({
    kind: "terminal",
    path: options?.path,
    session_id: options?.id,
  });
  if (pty?.pid != null) {
    registry.attachPid(root.root_id, pty.pid);
  }
  pty.once("exit", () => {
    registry.markExited(root.root_id, { pid: pty?.pid });
    registry.removeRoot(root.root_id);
  });

  const spoolDir = options?.env?.COCALC_CONTROL_DIR;
  if (!spoolDir) {
    return;
  }
  const messageSpool = new SpoolWatcher(spoolDir, async (payload) => {
    pty.emit("broadcast", "user-command", payload);
  });
  pty.once("exit", () => {
    messageSpool.close();
  });
  await messageSpool.start();

  if (supportsTerminalCwdLookup() && process.env.HOME != null) {
    let cur: string | undefined = "";
    pty.on(
      "data",
      debounce(
        async () => {
          try {
            const c = await terminalCwdForPid(pty.pid);
            if (c != cur) {
              cur = c;
              pty.emit("broadcast", "update-cwd", cur);
            }
          } catch {}
        },
        250,
        { leading: true, trailing: true },
      ),
    );
  }
}
