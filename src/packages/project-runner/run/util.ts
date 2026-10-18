import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import {
  mkdirBeneathHome,
  rmBeneathHome,
  writeFileBeneathHome,
} from "@cocalc/backend/files/beneath-home";
import getLogger from "@cocalc/backend/logger";
import { dataPath, secretTokenPath } from "./env";
import { root } from "@cocalc/backend/data";

const logger = getLogger("project-runner:util");

const DEFAULT_SHELL_FILES: { [key: string]: string } = {
  bashrc: `# Auto-created by cocalc-project-runner.
export SHELL=/bin/bash
export PATH="$HOME/.local/bin:$PATH"
`,
  bash_profile: `if [ -f ~/.bashrc ]; then
  . ~/.bashrc
fi
`,
};

function templateRoots(): string[] {
  // Support source-tree runs, tsc dist runs, and ncc bundle runs.
  // In bundled runs, templates are copied beside the bundle entrypoint.
  return [
    __dirname,
    join(__dirname, ".."),
    join(__dirname, "..", ".."),
    root,
    join(root, "packages", "project-runner"),
  ];
}

function templateSources(file: string): string[] {
  const platforms =
    process.platform === "linux" ? ["linux"] : [process.platform, "linux"];
  const sources: string[] = [];
  for (const base of templateRoots()) {
    for (const platform of platforms) {
      sources.push(join(base, "templates", platform, file));
    }
  }
  return sources;
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err == "object" && err != null && (err as any).code === code;
}

async function existingShellFileIsUsable({
  home,
  target,
}: {
  home: string;
  target: string;
}): Promise<boolean> {
  let fileStat;
  try {
    fileStat = await lstat(target);
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      return false;
    }
    throw err;
  }

  if (!fileStat.isSymbolicLink()) {
    return true;
  }

  const link = await readlink(target);
  if (isAbsolute(link)) {
    logger.warn("ensureConfFilesExists: replacing absolute shell symlink", {
      target,
      link,
    });
    return false;
  }

  const resolved = resolve(dirname(target), link);
  const resolvedHome = resolve(home);
  if (resolved != resolvedHome && !resolved.startsWith(`${resolvedHome}/`)) {
    logger.warn("ensureConfFilesExists: replacing escaping shell symlink", {
      target,
      link,
      resolved,
    });
    return false;
  }

  try {
    await stat(target);
    return true;
  } catch (err) {
    if (hasCode(err, "ENOENT")) {
      logger.warn("ensureConfFilesExists: replacing broken shell symlink", {
        target,
        link,
      });
      return false;
    }
    throw err;
  }
}

async function ensureShellFile({
  home,
  file,
}: {
  home: string;
  file: "bashrc" | "bash_profile";
}): Promise<void> {
  const target = join(home, `.${file}`);
  if (await existingShellFileIsUsable({ home, target })) {
    logger.debug("ensureConfFilesExists: already exists", { target });
    return;
  }

  // The home belongs to the project user: write through beneath-home, which
  // replaces whatever is at the target (an escaping symlink included) and
  // never follows a link swapped in after the check above.
  const name = `.${file}`;
  for (const source of templateSources(file)) {
    let content: string;
    try {
      content = await readFile(source, "utf8");
    } catch {
      continue; // try next source candidate
    }
    writeFileBeneathHome(home, name, content, { mode: 0o644 });
    logger.debug("ensureConfFilesExists: copied template", {
      file,
      source,
      target,
    });
    return;
  }

  writeFileBeneathHome(home, name, DEFAULT_SHELL_FILES[file], { mode: 0o644 });
  logger.warn("ensureConfFilesExists: wrote fallback shell file", {
    file,
    target,
    tried: templateSources(file),
  });
}

export async function ensureConfFilesExists(HOME: string): Promise<void> {
  await ensureShellFile({ home: HOME, file: "bashrc" });
  await ensureShellFile({ home: HOME, file: "bash_profile" });
}

// The data directory and secret token live under the project user's home, so
// every step goes through beneath-home: a symlinked parent (say ~/.cache
// pointing at a host directory or another project) fails the step instead of
// deleting or writing outside the home.
export async function setupDataPath(HOME: string): Promise<void> {
  const data = relative(HOME, dataPath(HOME));
  logger.debug(`setup "${data}"...`);
  await rmBeneathHome(HOME, data);
  mkdirBeneathHome(HOME, data, 0o755);
}

export async function writeSecretToken(
  HOME: string,
  secretToken: string,
): Promise<void> {
  writeFileBeneathHome(
    HOME,
    relative(HOME, secretTokenPath(HOME)),
    secretToken,
    { mode: 0o600, dirMode: 0o755, chmodDir: false },
  );
}
