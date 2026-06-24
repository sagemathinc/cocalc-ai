/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import type { RootfsRecipe } from "./rootfs-recipe";

export type BinderProvider = "gh";

export type BinderSpec = {
  provider: BinderProvider;
  owner: string;
  repo: string;
  ref: string;
};

export type BinderRootfsRecipeOptions = {
  baseImage?: string;
};

const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]+$/;

function normalizeToken(name: string, value: string): string {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed || !GITHUB_NAME_RE.test(trimmed)) {
    throw new Error(
      `invalid GitHub ${name} '${value}'; expected letters, digits, '.', '_', or '-'`,
    );
  }
  return trimmed;
}

function normalizeRef(ref: string): string {
  const trimmed = `${ref ?? ""}`.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new Error("Git ref must be non-empty and must not contain newlines");
  }
  return trimmed;
}

export function normalizeBinderSpec(
  provider: string,
  owner: string,
  repo: string,
  ref: string,
): BinderSpec {
  if (provider !== "gh") {
    throw new Error(
      `unsupported Binder provider '${provider}'; currently only 'gh' is supported`,
    );
  }
  return {
    provider,
    owner: normalizeToken("owner", owner),
    repo: normalizeToken("repository", repo),
    ref: normalizeRef(ref),
  };
}

function slug(value: string, fallback = "value"): string {
  const normalized = `${value ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function truncateSlug(
  value: string,
  maxLength: number,
  fallback: string,
): string {
  const truncated = value.slice(0, maxLength).replace(/-+$/g, "");
  return truncated || fallback;
}

function binderSpecHash(spec: BinderSpec): string {
  return createHash("sha256")
    .update(`${spec.provider}\0${spec.owner}\0${spec.repo}\0${spec.ref}`)
    .digest("hex")
    .slice(0, 8);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function binderRecipeName(spec: BinderSpec): string {
  const hash = binderSpecHash(spec);
  const prefix = "binder";
  const suffix = hash;
  const middleBudget = 39 - prefix.length - suffix.length - 2;
  const repo = slug(spec.repo, "repo");
  const ref = slug(spec.ref, "ref");
  const middle =
    `${repo}-${ref}`.length <= middleBudget
      ? `${repo}-${ref}`
      : `${truncateSlug(repo, Math.max(1, middleBudget - 5), "repo")}-${truncateSlug(
          ref,
          4,
          "ref",
        )}`;
  return `${prefix}-${middle}-${suffix}`;
}

export function binderRepoUrl(spec: BinderSpec): string {
  switch (spec.provider) {
    case "gh":
      return `https://github.com/${spec.owner}/${spec.repo}.git`;
  }
}

export function binderProjectLabels(spec: BinderSpec): Record<string, string> {
  return {
    "cocalc.com/rootfs-origin": "binder",
    "cocalc.com/binder-provider": spec.provider,
    "cocalc.com/binder-owner": spec.owner,
    "cocalc.com/binder-repo": spec.repo,
    "cocalc.com/binder-ref": spec.ref,
  };
}

function binderInstallScript(spec: BinderSpec): string {
  const repoUrl = binderRepoUrl(spec);
  const repoPath = `/opt/cocalc-binder/${slug(spec.owner)}-${slug(spec.repo)}`;
  return `set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo -n"
fi

run_noninteractive() {
  if [ -n "$SUDO" ]; then
    $SUDO env DEBIAN_FRONTEND=noninteractive "$@"
  else
    DEBIAN_FRONTEND=noninteractive "$@"
  fi
}

BINDER_REPO_URL=${shellQuote(repoUrl)}
BINDER_REF=${shellQuote(spec.ref)}
BINDER_REPO_PATH=${shellQuote(repoPath)}

echo "[binder] repository: $BINDER_REPO_URL"
echo "[binder] requested ref: $BINDER_REF"

$SUDO apt-get update
run_noninteractive apt-get install -y --no-install-recommends \\
  bash \\
  build-essential \\
  ca-certificates \\
  curl \\
  git \\
  pkg-config \\
  python3 \\
  python3-dev \\
  python3-pip \\
  python3-venv \\
  sudo

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

rm -rf "$tmp/repo"
if ! git clone --depth 1 --branch "$BINDER_REF" "$BINDER_REPO_URL" "$tmp/repo"; then
  echo "[binder] shallow branch/tag clone failed; retrying full clone and checkout"
  git clone "$BINDER_REPO_URL" "$tmp/repo"
  git -C "$tmp/repo" checkout "$BINDER_REF"
fi

commit="$(git -C "$tmp/repo" rev-parse HEAD)"
echo "[binder] resolved commit: $commit"

$SUDO rm -rf "$BINDER_REPO_PATH"
$SUDO mkdir -p "$(dirname "$BINDER_REPO_PATH")"
$SUDO cp -a "$tmp/repo" "$BINDER_REPO_PATH"
$SUDO mkdir -p /opt/cocalc-binder
printf '%s\\n' "$commit" | $SUDO tee /opt/cocalc-binder/COMMIT >/dev/null
printf '%s\\n' "$BINDER_REPO_URL" | $SUDO tee /opt/cocalc-binder/REPO_URL >/dev/null
printf '%s\\n' "$BINDER_REF" | $SUDO tee /opt/cocalc-binder/REF >/dev/null

cd "$BINDER_REPO_PATH"

BINDER_CONFIG_DIR="."
if [ -d binder ]; then
  BINDER_CONFIG_DIR="binder"
elif [ -d .binder ]; then
  BINDER_CONFIG_DIR=".binder"
fi
echo "[binder] config directory: $BINDER_CONFIG_DIR"

if [ -f "$BINDER_CONFIG_DIR/runtime.txt" ]; then
  echo "[binder] runtime.txt detected:"
  sed 's/^/[binder]   /' "$BINDER_CONFIG_DIR/runtime.txt"
  echo "[binder] Python runtime pinning is not implemented yet; using the CoCalc base Python."
fi

if [ -f "$BINDER_CONFIG_DIR/apt.txt" ]; then
  echo "[binder] installing apt.txt packages"
  grep -vE '^\\s*(#|$)' "$BINDER_CONFIG_DIR/apt.txt" > "$tmp/apt-packages.txt" || true
  if [ -s "$tmp/apt-packages.txt" ]; then
    mapfile -t apt_packages < "$tmp/apt-packages.txt"
    run_noninteractive apt-get install -y --no-install-recommends "\${apt_packages[@]}"
  fi
fi

if [ -f "$BINDER_CONFIG_DIR/environment.yml" ] || [ -f "$BINDER_CONFIG_DIR/environment.yaml" ]; then
  if [ -f "$BINDER_CONFIG_DIR/requirements.txt" ]; then
    echo "[binder] environment.yml detected; using requirements.txt as the pip-compatible fallback."
  else
    echo "[binder] environment.yml detected but conda environment builds are not implemented in this first CoCalc Binder recipe generator."
    echo "[binder] Add equivalent packages to requirements.txt or extend the generated recipe before building."
    exit 1
  fi
fi

if [ -f "$BINDER_CONFIG_DIR/requirements.txt" ]; then
  echo "[binder] installing requirements.txt into the CoCalc Python/Jupyter environment"
  python -m pip install --no-cache-dir -r "$BINDER_CONFIG_DIR/requirements.txt"
fi

if [ -f "$BINDER_CONFIG_DIR/postBuild" ]; then
  echo "[binder] running postBuild"
  bash "$BINDER_CONFIG_DIR/postBuild"
fi

$SUDO chown -R 2001:2001 /opt/cocalc-binder
$SUDO chmod -R u+rwX,go+rX /opt/cocalc-binder
$SUDO rm -rf /var/lib/apt/lists/*
`;
}

export function generateBinderRootfsRecipe(
  spec: BinderSpec,
  options: BinderRootfsRecipeOptions = {},
): RootfsRecipe {
  const name = binderRecipeName(spec);
  const repoUrl = binderRepoUrl(spec);
  const repoPath = `/opt/cocalc-binder/${slug(spec.owner)}-${slug(spec.repo)}`;
  return {
    version: 1,
    name,
    base: options.baseImage ? { image: options.baseImage } : undefined,
    builder: {
      run_quota: {
        disk_quota: 40000,
      },
    },
    steps: [
      {
        uses: "cocalc/uv-python",
        timeout: 1800,
      },
      {
        name: "Build Binder-compatible repository environment",
        run: binderInstallScript(spec),
        timeout: 3600,
      },
    ],
    verify: [
      "command -v git",
      "command -v python",
      "command -v pip",
      "command -v jupyter-lab",
      `test -d ${shellQuote(repoPath)}`,
      "jupyter kernelspec list | grep -q python3",
    ],
    publish: {
      label: `Binder: ${spec.owner}/${spec.repo}`,
      slug: name,
      description: `CoCalc RootFS generated from Binder repository ${repoUrl} at ref ${spec.ref}. Supports requirements.txt, apt.txt, and postBuild in the initial implementation.`,
      family: "binder",
      version: spec.ref,
      channel: "binder",
      visibility: "collaborators",
      tags: [
        "binder",
        "github",
        `owner-${slug(spec.owner)}`,
        `repo-${slug(spec.repo)}`,
      ],
      content: {
        version: 1,
        title: `Binder: ${spec.owner}/${spec.repo}`,
        subtitle: `Generated from ${repoUrl} at ${spec.ref}.`,
        highlights: [
          "Binder-compatible build",
          "JupyterLab",
          "Python requirements.txt",
          "Repository content included",
        ],
        actions: [
          {
            kind: "copy-to-home",
            label: "Copy Binder repository to home",
            source_path: repoPath,
            target_path: spec.repo,
          },
          {
            kind: "browse",
            label: "Browse Binder repository in image",
            path: repoPath,
          },
          {
            kind: "external-link",
            label: "GitHub repository",
            url: `https://github.com/${spec.owner}/${spec.repo}`,
          },
        ],
      },
    },
  };
}
