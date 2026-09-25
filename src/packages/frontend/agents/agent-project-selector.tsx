/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Button } from "antd";
import { SelectProject } from "@cocalc/frontend/projects/select-project";

export function AgentProjectSelector({
  value,
  disabled,
  onChange,
  onCreate,
}: {
  value?: string;
  disabled: boolean;
  onChange: (projectId: string) => void;
  onCreate: () => void;
}) {
  return (
    <div>
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span>Project</span>
        <Button
          aria-label="Create project"
          size="small"
          disabled={disabled}
          onClick={onCreate}
        >
          Create
        </Button>
      </div>
      <SelectProject
        ariaLabel="Project"
        fullCollaboratorOnly
        value={value}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}
