/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Input, Select } from "antd";
import React from "react";
import {
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY,
  normalizeProjectViewerPolicyPath,
  type ProjectViewerReadPolicy,
  type ProjectViewerReadRule,
} from "@cocalc/util/project-access";
import { COLORS } from "@cocalc/util/theme";

type ViewerReadPolicyPreset = "full" | "selected";

const DEFAULT_EXCLUDE_RULES: ProjectViewerReadRule[] =
  DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY.rules.filter(
    (rule) => rule.action === "exclude",
  );

const DEFAULT_EXCLUDE_PATHS = new Set(
  DEFAULT_EXCLUDE_RULES.map((rule) => rule.path),
);

function hasGlob(path: string): boolean {
  return path.includes("*");
}

function policyPreset(policy: ProjectViewerReadPolicy): ViewerReadPolicyPreset {
  return policy.rules.some(
    (rule) =>
      rule.action === "include" &&
      normalizeProjectViewerPolicyPath(rule.path) === "",
  )
    ? "full"
    : "selected";
}

export function selectedViewerPolicyFromText(
  text: string,
): ProjectViewerReadPolicy {
  const includeRules: ProjectViewerReadRule[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const directoryLike = raw.endsWith("/");
    const normalized = normalizeProjectViewerPolicyPath(raw);
    if (normalized == null) {
      continue;
    }
    const path = normalized || ".";
    const candidates =
      directoryLike && !hasGlob(path) && path !== "."
        ? [path, `${path}/**`]
        : [path];
    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      includeRules.push({ action: "include", path: candidate });
    }
  }
  return {
    rules: [...includeRules, ...DEFAULT_EXCLUDE_RULES],
  };
}

export function selectedTextFromViewerPolicy(
  policy: ProjectViewerReadPolicy,
): string {
  const includes = policy.rules
    .filter(
      (rule) =>
        rule.action === "include" &&
        !DEFAULT_EXCLUDE_PATHS.has(rule.path) &&
        normalizeProjectViewerPolicyPath(rule.path) !== "",
    )
    .map((rule) => rule.path);
  const collapsed: string[] = [];
  const consumed = new Set<string>();
  for (const path of includes) {
    if (consumed.has(path)) {
      continue;
    }
    if (path.endsWith("/**")) {
      const base = path.slice(0, -3);
      if (includes.includes(base)) {
        consumed.add(base);
        consumed.add(path);
        collapsed.push(`${base}/`);
        continue;
      }
    }
    if (includes.includes(`${path}/**`)) {
      consumed.add(path);
      consumed.add(`${path}/**`);
      collapsed.push(`${path}/`);
      continue;
    }
    consumed.add(path);
    collapsed.push(path);
  }
  return collapsed.join("\n");
}

export function viewerPolicyHasReadablePath(
  policy: ProjectViewerReadPolicy,
): boolean {
  return policy.rules.some((rule) => rule.action === "include");
}

export function viewerReadPolicySummary(
  policy?: ProjectViewerReadPolicy | null,
): string {
  if (policy == null || !viewerPolicyHasReadablePath(policy)) {
    return "No files allowed";
  }
  if (policyPreset(policy) === "full") {
    return "Full project except sensitive paths";
  }
  const selected = selectedTextFromViewerPolicy(policy)
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => !!path);
  if (selected.length === 0) {
    return "Selected files and directories";
  }
  const preview = selected.slice(0, 3).join(", ");
  return selected.length > 3
    ? `Selected: ${preview} + ${selected.length - 3} more`
    : `Selected: ${preview}`;
}

export function ViewerReadPolicyEditor({
  onChange,
  value,
}: {
  onChange: (policy: ProjectViewerReadPolicy) => void;
  value: ProjectViewerReadPolicy;
}): React.JSX.Element {
  const preset = policyPreset(value);
  const selectedText = selectedTextFromViewerPolicy(value);
  const selectedHasReadablePath = viewerPolicyHasReadablePath(value);

  function setPreset(nextPreset: ViewerReadPolicyPreset): void {
    if (nextPreset === "full") {
      onChange(DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY);
      return;
    }
    onChange(
      selectedViewerPolicyFromText(selectedText || "README.md\npublic/"),
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Viewer file access</div>
      <Select
        style={{ width: "100%" }}
        value={preset}
        onChange={(nextPreset) =>
          setPreset(nextPreset as ViewerReadPolicyPreset)
        }
        options={[
          {
            value: "full",
            label: "Full project, excluding sensitive paths",
          },
          {
            value: "selected",
            label: "Selected files and directories only",
          },
        ]}
      />
      {preset === "full" ? (
        <div style={{ color: COLORS.GRAY_M, fontSize: 12, marginTop: 6 }}>
          Includes the whole project except <code>.snapshots</code>,{" "}
          <code>.ssh</code>, and <code>.local/share/cocalc</code>. These
          sensitive paths stay excluded in the first viewer milestone.
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <Input.TextArea
            autoSize={{ minRows: 3, maxRows: 8 }}
            placeholder={"README.md\npublic/\ndocs/**/*.md"}
            value={selectedText}
            onChange={(e) =>
              onChange(selectedViewerPolicyFromText(e.target.value))
            }
          />
          <div style={{ color: COLORS.GRAY_M, fontSize: 12, marginTop: 6 }}>
            Enter one project-relative file, directory, or glob per line. A
            directory ending in <code>/</code> includes everything under it.
            Sensitive defaults remain excluded.
          </div>
          {!selectedHasReadablePath && (
            <Alert
              showIcon
              type="warning"
              style={{ marginTop: 8 }}
              message="This viewer policy currently allows no files."
            />
          )}
        </div>
      )}
    </div>
  );
}
