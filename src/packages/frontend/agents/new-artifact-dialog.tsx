/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "New Artifact": pick a kind, fill a short form, and the artifact is added
// to the chosen project's Library conversation (see library-create).

import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Input, Modal, Select, Typography } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon, type IconName } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  buildArtifactContent,
  fetchGitHubPR,
  type NewArtifactKind,
} from "./library-artifact-content";
import { createLibraryArtifact } from "./library-create";

const KINDS: {
  kind: NewArtifactKind;
  icon: IconName;
  name: string;
  description: string;
}[] = [
  {
    kind: "markdown",
    icon: "file-alt",
    name: "Document",
    description: "Notes, a plan or a write-up in Markdown.",
  },
  {
    kind: "file",
    icon: "file",
    name: "File or image",
    description: "A file in the project, previewed in Artifacts.",
  },
  {
    kind: "github-pr",
    icon: "github",
    name: "GitHub pull request",
    description: "A PR card with its state and revisions.",
  },
  {
    kind: "actions",
    icon: "check-square",
    name: "Decision list",
    description: "Items people approve or reject, with comments.",
  },
];

export function NewArtifactDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const project_map = useTypedRedux("projects", "project_map");
  const account_id = useTypedRedux("account", "account_id");
  const lastProject = useTypedRedux("page", "last_project_tab");
  const projects = useMemo(() => {
    const list: { value: string; label: string; used: number }[] = [];
    project_map?.forEach((project, project_id: string) => {
      if (project.get("deleted")) return;
      list.push({
        value: project_id,
        label: project.get("title") || "Untitled",
        used: new Date(
          (project.getIn(["last_active", account_id]) as any) ?? 0,
        ).valueOf(),
      });
    });
    return list.sort((a, b) => b.used - a.used);
  }, [project_map, account_id]);

  const [kind, setKind] = useState<NewArtifactKind>();
  const [project_id, setProject] = useState<string>();
  const [title, setTitle] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [path, setPath] = useState("");
  const [decisions, setDecisions] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [pr, setPr] = useState<Awaited<ReturnType<typeof fetchGitHubPR>>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setKind(undefined);
    setTitle("");
    setMarkdown("");
    setPath("");
    setDecisions("");
    setPrUrl("");
    setPr(undefined);
    setError("");
    setProject(
      lastProject && project_map?.get(lastProject)
        ? lastProject
        : projects[0]?.value,
    );
  }, [open]);

  async function lookup() {
    setError("");
    setBusy(true);
    try {
      const result = await fetchGitHubPR(prUrl);
      setPr(result);
      if (!title.trim()) setTitle(result.title);
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!kind || !project_id) return;
    setError("");
    let content;
    try {
      content = buildArtifactContent(kind, {
        title,
        markdown,
        path,
        decisions,
        pr,
      });
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
      return;
    }
    setBusy(true);
    try {
      await createLibraryArtifact({ project_id, content });
      onCreated?.();
      onClose();
    } catch (err) {
      setError(`${err}`.replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  }

  const chosen = KINDS.find((k) => k.kind === kind);
  return (
    <Modal
      open={open}
      title={chosen ? `New ${chosen.name.toLowerCase()}` : "New artifact"}
      onCancel={onClose}
      destroyOnHidden
      width={640}
      footer={
        kind ? (
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => setKind(undefined)}>Back</Button>
            <span style={{ flex: 1 }} />
            <Button onClick={onClose}>Cancel</Button>
            <Button
              type="primary"
              loading={busy}
              disabled={!project_id}
              onClick={() => void create()}
            >
              Add artifact
            </Button>
          </div>
        ) : null
      }
    >
      {!kind ? (
        <div
          role="list"
          aria-label="Artifact kinds"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 10,
          }}
        >
          {KINDS.map((k) => (
            <button
              key={k.kind}
              role="listitem"
              type="button"
              aria-label={k.name}
              onClick={() => setKind(k.kind)}
              style={{
                display: "flex",
                gap: 12,
                alignItems: "flex-start",
                padding: 14,
                border: `1px solid ${UI_COLORS.border}`,
                borderRadius: 10,
                background: UI_COLORS.surface,
                color: UI_COLORS.text,
                cursor: "pointer",
                textAlign: "left",
                font: "inherit",
              }}
            >
              <Icon name={k.icon} style={{ fontSize: 22, marginTop: 2 }} />
              <span>
                <strong style={{ display: "block" }}>{k.name}</strong>
                <span style={{ color: UI_COLORS.secondary, fontSize: 13 }}>
                  {k.description}
                </span>
              </span>
            </button>
          ))}
          <Typography.Paragraph
            type="secondary"
            style={{ gridColumn: "1 / -1", margin: "6px 0 0", fontSize: 13 }}
          >
            Agents publish these too, along with commits and more. Artifacts you
            add here go to the project's Artifacts conversation, so its
            collaborators see them.
          </Typography.Paragraph>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label>
            Project
            <Select
              aria-label="Project"
              showSearch
              optionFilterProp="label"
              value={project_id}
              onChange={setProject}
              options={projects}
              style={{ width: "100%", marginTop: 4 }}
            />
          </label>
          {kind === "github-pr" && (
            <Input.Search
              aria-label="Pull request URL"
              placeholder="https://github.com/owner/repo/pull/123"
              enterButton="Look up"
              loading={busy}
              value={prUrl}
              onChange={(e) => {
                setPrUrl(e.target.value);
                setPr(undefined);
              }}
              onSearch={() => void lookup()}
            />
          )}
          {kind === "github-pr" && pr && (
            <Typography.Text type="secondary">
              {pr.github_pr.repository}#{pr.github_pr.number} ·{" "}
              {pr.github_pr.state}
              {pr.github_pr.draft ? " (draft)" : ""}
            </Typography.Text>
          )}
          {kind === "file" && (
            <Input
              aria-label="File path"
              placeholder="Path in the project, e.g. results/plot.png"
              value={path}
              onChange={(e) => setPath(e.target.value)}
            />
          )}
          <Input
            aria-label="Title"
            placeholder={kind === "markdown" ? "Title" : "Title (optional)"}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
          {kind === "actions" && (
            <Input.TextArea
              aria-label="Items"
              placeholder="One item per line"
              autoSize={{ minRows: 4, maxRows: 12 }}
              value={decisions}
              onChange={(e) => setDecisions(e.target.value)}
            />
          )}
          {kind !== "github-pr" && (
            <Input.TextArea
              aria-label={kind === "markdown" ? "Content" : "Description"}
              placeholder={
                kind === "markdown"
                  ? "Write in Markdown"
                  : "Description (optional, Markdown)"
              }
              autoSize={{ minRows: kind === "markdown" ? 8 : 2, maxRows: 20 }}
              value={markdown}
              onChange={(e) => setMarkdown(e.target.value)}
            />
          )}
        </div>
      )}
      {error && (
        <Alert
          role="alert"
          type="error"
          style={{ marginTop: 10 }}
          title={error}
        />
      )}
    </Modal>
  );
}
