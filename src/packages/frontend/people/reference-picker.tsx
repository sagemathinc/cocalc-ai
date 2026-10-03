/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import { Input, Modal, Segmented, Typography } from "antd";
import { useNamedAgents } from "@cocalc/frontend/agents/api";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import type { ListedConversation } from "@cocalc/util/people";
import {
  makePeopleReference,
  type PeopleReference,
  type PeopleReferenceKind,
} from "@cocalc/util/people-references";

export interface ReferenceOption {
  kind: PeopleReferenceKind;
  project_id: string;
  id: string;
  label: string;
  detail: string;
}

const MAX_NAMED_ARTIFACTS = 30;

// Named Library artifacts (any project) and the current project's catalog.
function useArtifactOptions(open: boolean, project_id: string) {
  const [options, setOptions] = useState<ReferenceOption[]>([]);
  const project_map = useTypedRedux("projects", "project_map");
  useEffect(() => {
    if (!open) return;
    let canceled = false;
    void (async () => {
      const hub = webapp_client.conat_client.hub;
      const found = new Map<string, ReferenceOption>();
      const title = (pid: string) =>
        (project_map?.getIn([pid, "title"]) as string | undefined) ?? "";
      try {
        const page = await hub.artifactCatalog.listProject({ project_id });
        for (const entry of page.entries) {
          found.set(`${project_id}:${entry.entry_id}`, {
            kind: "artifact",
            project_id,
            id: entry.entry_id,
            label: entry.item.title || "Untitled artifact",
            detail: title(project_id),
          });
        }
      } catch {}
      try {
        const library = await hub.personalLibrary.list({});
        for (const alias of library.aliases
          .filter((a) => a.active)
          .slice(0, MAX_NAMED_ARTIFACTS)) {
          const key = `${alias.project_id}:${alias.entry_id}`;
          const existing = found.get(key);
          if (existing) {
            existing.detail = `@${alias.name} · ${existing.detail}`;
            continue;
          }
          const entry = await hub.artifactCatalog
            .getEntry({
              project_id: alias.project_id,
              entry_id: alias.entry_id,
            })
            .catch(() => null);
          if (!entry) continue;
          found.set(key, {
            kind: "artifact",
            project_id: alias.project_id,
            id: alias.entry_id,
            label: entry.item.title || `@${alias.name}`,
            detail: `@${alias.name} · ${title(alias.project_id)}`,
          });
        }
      } catch {}
      if (!canceled) setOptions([...found.values()]);
    })();
    return () => {
      canceled = true;
    };
  }, [open, project_id]);
  return options;
}

// Choose a conversation, agent or artifact to link from a message.
export function ReferencePicker({
  open,
  project_id,
  conversations,
  onPick,
  onClose,
}: {
  open: boolean;
  project_id: string;
  conversations: ListedConversation[];
  onPick: (reference: PeopleReference) => void;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<PeopleReferenceKind>("artifact");
  const [query, setQuery] = useState("");
  const project_map = useTypedRedux("projects", "project_map");
  const { directory } = useNamedAgents(open);
  const artifacts = useArtifactOptions(open, project_id);
  const options = useMemo((): ReferenceOption[] => {
    const title = (pid: string) =>
      (project_map?.getIn([pid, "title"]) as string | undefined) ?? "";
    if (kind === "conversation") {
      return conversations.map((c) => ({
        kind,
        project_id: c.project_id,
        id: c.conversation_id,
        label: c.title,
        detail: `${c.alias ? `@${c.alias} · ` : ""}${title(c.project_id)}`,
      }));
    }
    if (kind === "agent") {
      return (directory?.agents ?? []).map((agent) => ({
        kind,
        project_id: agent.endpoint.project_id,
        id: agent.endpoint.agent_id,
        label: `@${agent.name}`,
        detail: agent.project_title ?? title(agent.endpoint.project_id),
      }));
    }
    return artifacts;
  }, [kind, conversations, directory, artifacts, project_map]);
  const q = query.trim().toLowerCase();
  const shown = options
    .filter(
      (o) =>
        !q ||
        o.label.toLowerCase().includes(q) ||
        o.detail.toLowerCase().includes(q),
    )
    .slice(0, 100);
  return (
    <Modal
      open={open}
      title="Insert a link"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      width={640}
    >
      <Typography.Paragraph type="secondary">
        Links show what they point to. People without access to that project can
        request it when they open the link.
      </Typography.Paragraph>
      <Segmented
        aria-label="Link to"
        value={kind}
        onChange={(value) => setKind(value as PeopleReferenceKind)}
        options={[
          { value: "artifact", label: "Artifacts" },
          { value: "conversation", label: "Conversations" },
          { value: "agent", label: "Agents" },
        ]}
        style={{ marginBottom: 8 }}
      />
      <Input
        type="search"
        aria-label="Filter links"
        placeholder="Filter"
        autoFocus
        allowClear
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul
        aria-label="Link targets"
        style={{
          listStyle: "none",
          margin: "8px 0 0",
          padding: 0,
          maxHeight: 360,
          overflowY: "auto",
        }}
      >
        {shown.length === 0 && (
          <li style={{ color: UI_COLORS.secondary, padding: 8 }}>
            Nothing found.
          </li>
        )}
        {shown.map((o) => (
          <li key={`${o.kind}:${o.project_id}:${o.id}`}>
            <button
              type="button"
              onClick={() => {
                onPick(
                  makePeopleReference(o.kind, o.project_id, o.id, o.label),
                );
                onClose();
              }}
              style={{
                display: "flex",
                gap: 8,
                width: "100%",
                textAlign: "left",
                border: "none",
                borderBottom: `1px solid ${UI_COLORS.border}`,
                background: "transparent",
                color: UI_COLORS.text,
                padding: "8px 4px",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {o.label}
              </span>
              <span
                style={{
                  color: UI_COLORS.secondary,
                  fontSize: 12,
                  maxWidth: "45%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {o.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
