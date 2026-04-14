import { type Options } from "./server";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const children: ChildProcess[] = [];

function resolveClusterNodeEntrypoint(): string {
  const explicit =
    `${process.env.COCALC_CONAT_CLUSTER_NODE_ENTRYPOINT ?? ""}`.trim();
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(
        `COCALC_CONAT_CLUSTER_NODE_ENTRYPOINT does not exist: ${explicit}`,
      );
    }
    return explicit;
  }
  return join(
    __dirname,
    "..",
    "..",
    "..",
    "server",
    "dist",
    "conat",
    "socketio",
    "start-cluster-node.js",
  );
}

export function forkedConatServer(opts: Options) {
  const child: ChildProcess = fork(resolveClusterNodeEntrypoint(), [], {
    env: {
      ...process.env,
      COCALC_CONAT_CLUSTER_NODE: "1",
    },
  });
  children.push(child);
  child.send(opts);
}

function close() {
  children.map((child) => child.kill("SIGKILL"));
}

process.once("exit", () => {
  close();
});

["SIGTERM", "SIGQUIT"].forEach((sig) => {
  process.once(sig, () => {
    children.map((child) => child.kill(sig as any));
  });
});
