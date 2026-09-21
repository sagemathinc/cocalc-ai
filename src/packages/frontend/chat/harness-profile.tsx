import { Input, Space, Typography } from "antd";
import { useId } from "react";
import {
  parseAcpHarnessProfile,
  parseAcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import type { AcpHarnessRuntime } from "@cocalc/util/ai/runtime";

export interface HarnessProfileDraft {
  id: string;
  revision: string;
  executable: string;
  args: string;
}

export function HarnessRuntimeSummary({ runtime }: { runtime: unknown }) {
  let profile;
  try {
    profile = parseAcpHarnessRuntime(runtime).profile;
  } catch {
    return (
      <div role="alert">
        Invalid ACP runtime configuration. This thread cannot run.
      </div>
    );
  }
  return (
    <details>
      <summary>ACP: {profile.id} · Full project access</summary>
      <dl style={{ overflowWrap: "anywhere", margin: 8 }}>
        <dt>Credentials</dt>
        <dd>Project-managed (not CoCalc billing)</dd>
        <dt>Revision</dt>
        <dd>{profile.revision}</dd>
        <dt>Executable</dt>
        <dd>{profile.executable}</dd>
        <dt>Arguments</dt>
        <dd>{JSON.stringify(profile.args)}</dd>
        <dt>Working directory</dt>
        <dd>{profile.cwd}</dd>
      </dl>
    </details>
  );
}

export function harnessRuntimeFromDraft(
  draft: HarnessProfileDraft,
  cwd: string,
): AcpHarnessRuntime {
  return {
    version: 1,
    kind: "acp",
    profile: parseAcpHarnessProfile({
      version: 1,
      kind: "acp",
      id: draft.id.trim(),
      revision: draft.revision.trim(),
      executable: draft.executable.trim(),
      args: draft.args === "" ? [] : draft.args.split("\n"),
      cwd,
      executionPolicy: "full-access",
      credentialMode: "project-managed",
    }),
  };
}

export function HarnessProfileFields({
  value,
  onChange,
  disabled,
}: {
  value: HarnessProfileDraft;
  onChange: (value: HarnessProfileDraft) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Space orientation="vertical" style={{ width: "100%" }}>
      <Typography.Text type="secondary">
        Experimental: an operator must enable ACP harnesses on the project host.
        Install and configure the harness in this project first. It runs with
        full project access and project-managed credentials. Do not put secrets
        in these fields. Model selection uses the harness configuration; images,
        automations and incoming agent-network requests are not supported yet.
      </Typography.Text>
      {(
        [
          ["id", "Harness name"],
          ["revision", "Installed version / revision"],
          ["executable", "Executable (absolute project path)"],
        ] as const
      ).map(([key, label]) => (
        <div key={key}>
          <label htmlFor={`${id}-${key}`}>{label}</label>
          <Input
            id={`${id}-${key}`}
            value={value[key]}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </div>
      ))}
      <div>
        <label htmlFor={`${id}-args`}>
          Arguments (one per line, no shell quoting)
        </label>
        <Input.TextArea
          id={`${id}-args`}
          value={value.args}
          disabled={disabled}
          rows={3}
          onChange={(e) => onChange({ ...value, args: e.target.value })}
        />
      </div>
    </Space>
  );
}
