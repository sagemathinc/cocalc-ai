/**
 * Product shortcut command backend.
 *
 * This module supports `cocalc plus` and `cocalc launchpad` by checking tool
 * availability, prompting for installation, and invoking the product binary.
 */
import { createInterface } from "node:readline/promises";

export type ProductCommand = "plus" | "launchpad";

export type ProductSpec = {
  command: ProductCommand;
  binary: string;
  installUrl: string;
};

export const PRODUCT_SPECS: Record<ProductCommand, ProductSpec> = {
  plus: {
    command: "plus",
    binary: "cocalc-plus",
    installUrl:
      process.env.COCALC_PLUS_INSTALL_URL ??
      "https://software.cocalc.ai/software/cocalc-plus/install.sh",
  },
  launchpad: {
    command: "launchpad",
    binary: "cocalc-launchpad",
    installUrl:
      process.env.COCALC_LAUNCHPAD_INSTALL_URL ??
      "https://software.cocalc.ai/software/cocalc-launchpad/install.sh",
  },
};

type ProductCommandDeps = {
  commandExists: (command: string) => boolean;
  runCommand: (command: string, args: string[]) => Promise<number>;
};

async function shouldInstallProduct(spec: ProductSpec): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (
      await rl.question(
        `'${spec.binary}' is not installed. Install now from ${spec.installUrl}? [Y/n] `,
      )
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function ensureProductInstalled(
  spec: ProductSpec,
  deps: ProductCommandDeps,
): Promise<void> {
  if (deps.commandExists(spec.binary)) {
    return;
  }

  const approved = await shouldInstallProduct(spec);
  if (!approved) {
    throw new Error(
      `'${spec.binary}' is required for 'cocalc ${spec.command}'. Install with: curl -fsSL ${spec.installUrl} | bash`,
    );
  }

  console.error(`Installing ${spec.binary} ...`);
  const code = await deps.runCommand("bash", ["-lc", `curl -fsSL ${spec.installUrl} | bash`]);
  if (code !== 0) {
    throw new Error(`failed installing '${spec.binary}' (exit ${code})`);
  }
  if (!deps.commandExists(spec.binary)) {
    throw new Error(`installation completed but '${spec.binary}' is still not available in PATH`);
  }
}

export async function runProductCommand(
  spec: ProductSpec,
  args: string[],
  deps: ProductCommandDeps,
): Promise<void> {
  await ensureProductInstalled(spec, deps);
  const code = await deps.runCommand(spec.binary, args);
  if (code !== 0) {
    process.exitCode = code;
  }
}
