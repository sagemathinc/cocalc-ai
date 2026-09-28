/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { Input, Radio, Select } from "antd";
import type { InputRef } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components/icon";
import { VirtualCollectionList } from "@cocalc/frontend/components/virtual-collection";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type {
  CollaborationResource,
  CollaborationResourceKind,
  CollaborationTarget,
} from "@cocalc/util/collaborators";
import type { ReferencePickerApi } from "./reference-picker-api";
import { DirectoryResults } from "./directory-results";
import { useDirectory, useDirectorySearch } from "./use-directory";
import { shareSessionIsCurrent } from "./share-to-conversation";

type Scope = "project" | "participants" | "all";
function readScope(accountId?: string): Scope {
  try {
    const value = sessionStorage.getItem(`reference-scope:${accountId}`);
    return value === "participants" || value === "all" ? value : "project";
  } catch {
    return "project";
  }
}
const types = {
  conversation: "Conversation",
  agent: "Agent",
  artifact: "Artifact",
};

/** Both link directions share scope, search, access fencing and lazy paging. */
export function ResourcePicker({
  accountId,
  projectId,
  conversation,
  kind,
  api,
  searchRef,
  onSelect,
  accept,
  revalidateOnSelect = true,
  label = "References",
}: {
  accountId?: string;
  projectId?: string;
  conversation?: CollaborationTarget;
  kind?: CollaborationResourceKind;
  api: ReferencePickerApi;
  searchRef: RefObject<InputRef | null>;
  onSelect: (resource: CollaborationResource) => void;
  accept?: (resource: CollaborationResource) => boolean;
  /** False only when the caller reauthorizes before its explicit confirmation. */
  revalidateOnSelect?: boolean;
  label?: string;
}) {
  const id = useId();
  const projects = useTypedRedux("projects", "project_map");
  const projectTitle =
    (projectId && projects?.getIn?.([projectId, "title"])) || "Current project";
  const [selectedScope, setScope] = useState<Scope>(() => readScope(accountId));
  const scope =
    selectedScope === "participants" && !conversation
      ? projectId
        ? "project"
        : "all"
      : selectedScope === "project" && !projectId
        ? "all"
        : selectedScope;
  const [selectedKind, setKind] = useState<CollaborationResourceKind>();
  const [text, setText] = useState("");
  const search = useDirectorySearch(text);
  const query = {
    project_id: scope === "project" ? projectId : undefined,
    shared_with: scope !== "project" ? conversation : undefined,
    include_unshared: scope === "all" && !!conversation ? true : undefined,
    kind: kind ?? selectedKind,
    search: search.replace(/^@/, ""),
  };
  const key = JSON.stringify([accountId, query]);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    activeKey.current = key;
    return () => {
      activeKey.current = "";
    };
  }, [key]);
  const [selection, setSelection] = useState<{
    key: string;
    busy?: boolean;
    error?: string;
  }>();
  async function select(resource: CollaborationResource) {
    if (!revalidateOnSelect) {
      onSelect(resource);
      return;
    }
    if (!accountId || (selection?.key === key && selection.busy)) return;
    const sessionCurrent = shareSessionIsCurrent(accountId);
    const current = () => activeKey.current === key && sessionCurrent();
    setSelection({ key, busy: true });
    try {
      const fresh = await api.getResource({
        project_id: resource.project_id,
        kind: resource.kind,
        resource_id: resource.resource_id,
      });
      if (!current()) return;
      if (
        !fresh ||
        fresh.archived ||
        (accept && !accept(fresh)) ||
        collaborationTargetKey(fresh) !== collaborationTargetKey(resource)
      )
        throw Error("unavailable");
      setSelection({ key });
      onSelect(fresh);
    } catch {
      if (current())
        setSelection({
          key,
          error:
            "This content could not be opened. It may be unavailable or your access may have changed. Select it to retry.",
        });
    }
  }
  const result = useDirectory<CollaborationResource>(
    key,
    async (after) => {
      try {
        const page = await api.listResources({
          ...query,
          after,
          scope: "all",
          limit: 25,
        });
        return {
          ...page,
          items: accept ? page.items.filter(accept) : page.items,
        };
      } catch {
        throw Error("Could not load references. Try again.");
      }
    },
    !!accountId && search === text.trim(),
    true,
  );
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}
    >
      <label htmlFor={`${id}-search`}>Search titles or aliases</label>
      <Input
        id={`${id}-search`}
        ref={searchRef}
        autoFocus
        allowClear
        maxLength={128}
        value={text}
        onChange={(e) => setText(e.target.value)}
        prefix={<Icon name="search" />}
      />
      <label htmlFor={`${id}-scope`}>Search in</label>
      <Select
        id={`${id}-scope`}
        value={scope}
        style={{ width: "100%" }}
        onChange={(value: Scope) => {
          setScope(value);
          try {
            if (accountId)
              sessionStorage.setItem(`reference-scope:${accountId}`, value);
          } catch {
            /* A preference is not required for search. */
          }
        }}
        options={[
          ...(projectId
            ? [{ value: "project", label: `This project: ${projectTitle}` }]
            : []),
          ...(conversation
            ? [
                {
                  value: "participants",
                  label: "Projects shared by all participants",
                },
              ]
            : []),
          { value: "all", label: "All my projects" },
        ]}
      />
      {scope === "participants" && (
        <small>
          Shared by all current participants. Access can change; links do not
          grant access.
        </small>
      )}
      {scope === "all" && conversation && (
        <small id={`${id}-visibility-warning`}>
          Flagged items may not be visible to all participants. You can invite
          people afterward; recipients can also request project access. Links do
          not grant access.
        </small>
      )}
      {selection?.key === key && selection.error && (
        <p role="alert">{selection.error}</p>
      )}
      {!kind && (
        <Radio.Group
          aria-label="Resource type"
          optionType="button"
          buttonStyle="solid"
          style={{ display: "flex", flexWrap: "wrap", rowGap: 4 }}
          size="small"
          value={selectedKind ?? "all"}
          onChange={({ target: { value } }) =>
            setKind(
              value === "all"
                ? undefined
                : (value as CollaborationResourceKind),
            )
          }
          options={[
            { value: "all", label: "All" },
            { value: "conversation", label: "Conversations" },
            { value: "agent", label: "Agents" },
            { value: "artifact", label: "Artifacts" },
          ]}
        />
      )}
      {result.page && result.page.coverage !== "complete" && (
        <details style={{ fontSize: 12 }}>
          <summary>
            {result.page.coverage === "indexing"
              ? "Some results are still being indexed"
              : "Results may be incomplete"}
          </summary>
          <p style={{ maxHeight: 90, overflowY: "auto" }}>
            {result.page.coverage_message ||
              "Older resources may not have been discovered yet."}
          </p>
        </details>
      )}
      {!accountId ? (
        <p role="status">Sign in to find references.</p>
      ) : (
        <div style={{ height: "min(360px, 40dvh)", overflowY: "auto" }}>
          <DirectoryResults
            result={result}
            label={label}
            hideOptions
            empty="No matching references."
          >
            {(items) => (
              <VirtualCollectionList<CollaborationResource>
                items={items}
                itemId={collaborationTargetKey}
                renderItem={(resource) => (
                  <button
                    type="button"
                    aria-label={`${resource.personal?.alias ? `@${resource.personal.alias}: ` : ""}${resource.title || types[resource.kind]} (${types[resource.kind]})${scope !== "project" ? `, ${resource.project_title || "Untitled project"}` : ""}`}
                    aria-describedby={
                      scope === "all" &&
                      conversation &&
                      resource.shared_with_all_participants !== true
                        ? `${id}-visibility-warning`
                        : undefined
                    }
                    aria-disabled={
                      (selection?.key === key && selection.busy) || undefined
                    }
                    onClick={() => void select(resource)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      width: "100%",
                      padding: "10px 8px",
                      textAlign: "left",
                      color: UI_COLORS.text,
                      background: UI_COLORS.elevated,
                      border: 0,
                      borderBottom: `1px solid ${UI_COLORS.border}`,
                      cursor: "pointer",
                    }}
                  >
                    <Icon
                      name={
                        resource.kind === "conversation"
                          ? "comment"
                          : resource.kind === "agent"
                            ? "robot"
                            : "file"
                      }
                    />
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      <strong>{resource.title || types[resource.kind]}</strong>
                      {resource.personal?.alias && (
                        <span
                          style={{
                            marginLeft: 8,
                            color: UI_COLORS.secondary,
                          }}
                        >
                          @{resource.personal.alias}
                        </span>
                      )}
                      {scope !== "project" && (
                        <small
                          style={{
                            display: "block",
                            color: UI_COLORS.secondary,
                          }}
                        >
                          {resource.project_title || "Untitled project"}
                        </small>
                      )}
                      {scope === "all" &&
                        conversation &&
                        resource.shared_with_all_participants !== true && (
                          <small
                            style={{
                              display: "block",
                              color: UI_COLORS.secondary,
                            }}
                          >
                            <Icon name="exclamation-circle" /> May not be
                            visible to all participants
                          </small>
                        )}
                    </span>
                  </button>
                )}
              />
            )}
          </DirectoryResults>
        </div>
      )}
    </div>
  );
}
