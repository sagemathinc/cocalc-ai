/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "Shared with" on the New Agent page: the people who get the agent too.
// Each is invited when the agent is created; they add it to their own agents.

import { useMemo, useState } from "react";
import { Alert, Button, Select, Space, Tag } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import { Icon } from "@cocalc/frontend/components";
import { usePeople } from "@cocalc/frontend/people/collaborators";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  mostRecentSharedProject,
  projectIncludesAll,
} from "./agent-participants";

export function NewAgentPeople({
  participants,
  onChange,
  projectId,
  onSelectProject,
  disabled,
}: {
  participants: string[];
  onChange: (account_ids: string[]) => void;
  projectId?: string;
  // Omitted when the project is fixed (sharing an existing agent).
  onSelectProject?: (project_id: string) => void;
  disabled?: boolean;
}) {
  const people = usePeople();
  const projectMap = useTypedRedux("projects", "project_map");
  const [adding, setAdding] = useState(false);
  const nameOf = (id: string) =>
    people.find((p) => p.account_id === id)?.name ?? "Collaborator";
  const project = projectId ? projectMap?.get(projectId) : undefined;
  const missing = participants.filter(
    (id) => !projectIncludesAll(project, [id]),
  );
  const shared = useMemo(
    () =>
      missing.length > 0 && onSelectProject
        ? mostRecentSharedProject(projectMap, participants)
        : undefined,
    [projectMap, participants.join(","), missing.length],
  );
  const options = people
    .filter((p) => !participants.includes(p.account_id))
    .map((p) => ({ value: p.account_id, label: p.name }));

  return (
    <div
      role="group"
      aria-label="Shared with"
      style={{ padding: "0 10px", display: "grid", gap: 8 }}
    >
      <Space wrap size={6} align="center">
        <span style={{ color: UI_COLORS.secondary }}>
          {participants.length ? "Shared with" : "Just you"}
        </span>
        {participants.map((id) => (
          <Tag
            key={id}
            closable={!disabled}
            onClose={() => onChange(participants.filter((p) => p !== id))}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <Avatar account_id={id} size={18} no_tooltip />
            {nameOf(id)}
          </Tag>
        ))}
        {adding ? (
          <Select
            autoFocus
            showSearch
            open
            size="small"
            style={{ minWidth: 220 }}
            placeholder="Add a collaborator…"
            optionFilterProp="label"
            options={options}
            onChange={(id: string) => {
              onChange([...participants, id]);
              setAdding(false);
            }}
            onBlur={() => setAdding(false)}
            notFoundContent="No collaborators"
          />
        ) : (
          <Button
            size="small"
            type="text"
            disabled={disabled || options.length === 0}
            icon={<Icon name="user-plus" />}
            onClick={() => setAdding(true)}
          >
            {participants.length ? "Add person" : "Share with people"}
          </Button>
        )}
      </Space>
      {participants.length > 0 && missing.length === 0 && (
        <span style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
          They'll be invited when the agent is created. Anyone in the agent can
          start turns and send guidance; turns are billed to whoever starts
          them.
        </span>
      )}
      {missing.length > 0 && (
        <Alert
          type="info"
          showIcon
          title={`${missing.map(nameOf).join(", ")} ${
            missing.length === 1
              ? "isn't a collaborator"
              : "aren't collaborators"
          } on this project yet. They'll be invited to the project with the agent, and can use it once they accept.`}
          action={
            shared ? (
              <Button
                size="small"
                disabled={disabled}
                onClick={() => onSelectProject?.(shared)}
              >
                Use “
                {`${projectMap?.getIn([shared, "title"]) ?? "shared project"}`}”
              </Button>
            ) : undefined
          }
          description={
            shared ? "Or use a project you already all share." : undefined
          }
        />
      )}
    </div>
  );
}
