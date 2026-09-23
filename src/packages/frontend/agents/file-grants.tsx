/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Radio,
  Typography,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  normalizeAgentFileGrantRoots,
  type AgentFileGrant,
  type AgentFileGrantMode,
} from "@cocalc/conat/agents/file-grants";
import { fileGrantsForAgent } from "./file-grants-service";
import { SelectProject } from "@cocalc/frontend/projects/select-project";

export interface FileGrantsProps {
  projectId: string;
  path: string;
  threadId: string;
  open: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
  summary?: boolean;
  onEdit?: (projectId: string) => void;
  initialTargetProjectId?: string;
}

export function FileGrants(props: FileGrantsProps) {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? (
    <FileGrantsContents key={`${accountId}:${props.threadId}`} {...props} />
  ) : null;
}

function FileGrantsContents({
  projectId,
  path,
  threadId,
  open,
  onClose,
  onCountChange,
  summary = false,
  onEdit,
  initialTargetProjectId,
}: FileGrantsProps) {
  const projectMap: any = useTypedRedux("projects", "project_map");
  const [agentId, setAgentId] = useState<string>();
  const [grants, setGrants] = useState<AgentFileGrant[]>([]);
  const [targetProjectId, setTargetProjectId] = useState<string>();
  const [roots, setRoots] = useState(".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [wholeProject, setWholeProject] = useState(true);
  const [mode, setMode] = useState<AgentFileGrantMode>("read");
  const [helpOpen, setHelpOpen] = useState(false);
  const title = (id: string) =>
    projectMap?.getIn([id, "title"]) || "Untitled project";
  function selectProject(id: string) {
    setTargetProjectId(id);
    const existing = grants.find((grant) => grant.target_project_id === id);
    setMode(existing?.mode ?? "read");
    setRoots(existing?.roots.map((root) => root || ".").join("\n") ?? "");
    setWholeProject(
      !existing || existing.roots.some((root) => !root || root === "."),
    );
    setNotice("");
  }

  async function refresh(register = false) {
    let identity = await webapp_client.conat_client.hub.agent.resolveIdentity({
      project_id: projectId,
      path,
      thread_id: threadId,
    });
    if (!identity && register) {
      identity = await webapp_client.conat_client.hub.agent.registerIdentity({
        project_id: projectId,
        path,
        thread_id: threadId,
      });
    }
    setAgentId(identity?.agent_id);
    const next = identity
      ? await webapp_client.conat_client.hub.agent.listFileGrants({
          project_id: projectId,
          agent_id: identity.agent_id,
        })
      : [];
    setGrants(next);
    onCountChange?.(next.length);
    return identity;
  }

  useEffect(() => {
    if (!open) return;
    setNotice("");
    let disposed = false;
    setBusy(true);
    setError("");
    void fileGrantsForAgent({ projectId, path, threadId })
      .then(({ agentId, grants }) => {
        if (disposed) return;
        setAgentId(agentId);
        setGrants(grants);
        setTargetProjectId(initialTargetProjectId);
        const selected = grants.find(
          (grant) => grant.target_project_id === initialTargetProjectId,
        );
        setRoots(selected?.roots.map((root) => root || ".").join("\n") ?? "");
        setMode(selected?.mode ?? "read");
        setWholeProject(
          !selected || selected.roots.some((root) => !root || root === "."),
        );
        onCountChange?.(grants.length);
      })
      .catch((err) => !disposed && setError(String(err)))
      .finally(() => !disposed && setBusy(false));
    return () => {
      disposed = true;
    };
  }, [open, path, projectId, threadId, onCountChange, initialTargetProjectId]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (summary) {
    return (
      <KeyboardBoundary>
        <div
          style={{ width: 300, maxWidth: "75vw", overflowWrap: "anywhere" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onClose();
            }
          }}
        >
          {error && <Alert type="error" title={error} />}
          {busy && <div role="status">Loading...</div>}
          {grants.map((grant) => (
            <div key={grant.grant_id} style={{ marginBottom: 12 }}>
              <Typography.Text strong>
                {title(grant.target_project_id)}
              </Typography.Text>
              <div>
                {grant.mode === "read-write" ? "Read & write" : "Read-only"}
              </div>
              <div>
                {grant.roots
                  .map((root) =>
                    root && root !== "." ? root : "Whole project",
                  )
                  .join(", ")}
              </div>
              <Button
                icon={<Icon name="pencil" />}
                onClick={() => {
                  onEdit?.(grant.target_project_id);
                }}
              >
                Edit
              </Button>
            </div>
          ))}
        </div>
      </KeyboardBoundary>
    );
  }
  return (
    <Modal
      title="Files from another project"
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
      width={680}
      destroyOnHidden
    >
      <KeyboardBoundary>
        {busy && <div role="status">Working...</div>}
        {error && (
          <Alert
            type="error"
            showIcon
            title="File grant needs attention"
            description={error}
          />
        )}
        {notice && (
          <div role="status">
            <Alert type="success" showIcon title={notice} />
          </div>
        )}
        <Popover
          trigger="click"
          open={helpOpen}
          onOpenChange={setHelpOpen}
          title="File access for this agent"
          content={
            <KeyboardBoundary>
              <div style={{ width: 360, maxWidth: "75vw" }}>
                <p>
                  Access is checked for every operation. New access ends when
                  the agent run ends; operations already admitted may finish.
                  While a run is active, processes and collaborators in the
                  source project may be able to use its runtime credential.
                </p>
                <p>
                  Saved access is personal to this user and agent and is
                  available on future turns until removed.
                </p>
                <p>
                  Read &amp; write access can overwrite or delete data and
                  change code that target-project processes later execute. These
                  changes persist after the run ends. Writes through symlinks
                  are not supported.
                </p>
                <p>
                  This is ordinary filesystem access within the listed roots.
                  Project processes and collaborators can modify files
                  concurrently. CoCalc records grant configuration and
                  revocation, but does not provide a complete per-file activity
                  log or identify which source-project process used the shared
                  runtime credential.
                </p>
              </div>
            </KeyboardBoundary>
          }
        >
          <Button
            aria-label="About file access"
            icon={<Icon name="question-circle" />}
            onKeyDown={(event) => {
              if (event.key === "Escape" && helpOpen) {
                event.stopPropagation();
                setHelpOpen(false);
              }
            }}
          />
        </Popover>
        <Form layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="Project" htmlFor="file-grant-project">
            <SelectProject
              id="file-grant-project"
              exclude={[
                projectId,
                ...(projectMap
                  ?.filter((project) => project.get("deleted"))
                  .keySeq()
                  .toArray() ?? []),
              ]}
              fullCollaboratorOnly
              disabled={busy}
              value={
                projectMap?.has(targetProjectId) ? targetProjectId : undefined
              }
              onChange={selectProject}
            />
          </Form.Item>
          <Form.Item>
            <Radio.Group
              aria-label="File permission"
              name="file-grant-permission"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <Radio value="read">Read-only</Radio>
              <Radio value="read-write">Read &amp; write</Radio>
            </Radio.Group>
          </Form.Item>
          {mode === "read-write" && (
            <Typography.Paragraph type="warning">
              Allows creating, overwriting, renaming, and deleting files within
              the shared paths.
            </Typography.Paragraph>
          )}
          <Form.Item>
            <Radio.Group
              value={wholeProject}
              name="file-grant-scope"
              onChange={(event) => setWholeProject(event.target.value)}
            >
              <Radio value={true}>Share the whole project</Radio>
              <Radio value={false}>Share specific directories</Radio>
            </Radio.Group>
          </Form.Item>
          {!wholeProject && (
            <Form.Item
              label="Readable paths"
              htmlFor="file-grant-roots"
              extra="One literal project-home-relative file or directory per line. Directories include their full tree."
            >
              <Input.TextArea
                id="file-grant-roots"
                rows={4}
                value={roots}
                onChange={(event) => setRoots(event.target.value)}
                placeholder={"docs\nsrc/shared"}
              />
            </Form.Item>
          )}
          <Typography.Paragraph type="secondary">
            SSH files, snapshots, and CoCalc runtime credentials are never
            shared.
          </Typography.Paragraph>
          <Button
            type="primary"
            icon={<Icon name="plus" />}
            disabled={
              !targetProjectId || busy || (!wholeProject && !roots.trim())
            }
            onClick={() =>
              void run(async () => {
                const identity =
                  agentId != null ? { agent_id: agentId } : await refresh(true);
                if (!identity) throw new Error("agent identity unavailable");
                await webapp_client.conat_client.hub.agent.saveFileGrant({
                  project_id: projectId,
                  agent_id: identity.agent_id,
                  target_project_id: targetProjectId!,
                  mode,
                  roots: normalizeAgentFileGrantRoots(
                    wholeProject
                      ? ["."]
                      : roots.split(/\r?\n/).filter((root) => root.trim()),
                  ),
                });
                await refresh();
                setNotice(
                  `${mode === "read-write" ? "Read & write" : "Read"} access saved for this user and agent. It will be available on future turns.`,
                );
              })
            }
          >
            {mode === "read-write"
              ? "Save read & write access"
              : "Save read access"}
          </Button>
        </Form>
        <Typography.Title level={5}>Available on future turns</Typography.Title>
        {grants.length === 0 ? (
          <Typography.Paragraph type="secondary">
            No file grants configured.
          </Typography.Paragraph>
        ) : (
          grants.map((grant) => {
            return (
              <div
                key={grant.grant_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Button
                  type="link"
                  style={{
                    height: "auto",
                    whiteSpace: "normal",
                    flex: 1,
                    minWidth: 0,
                    overflowWrap: "anywhere",
                  }}
                  onClick={() => {
                    selectProject(grant.target_project_id);
                  }}
                >
                  {title(grant.target_project_id)}:{" "}
                  {grant.mode === "read-write"
                    ? "(read & write) "
                    : "(read-only) "}
                  {grant.roots
                    .map((root) =>
                      root && root !== "." ? root : "Whole project",
                    )
                    .join(", ")}
                </Button>
                <Popconfirm
                  title="Remove this file grant?"
                  description="New operations stop immediately. An operation already admitted may finish."
                  onConfirm={() =>
                    run(async () => {
                      await webapp_client.conat_client.hub.agent.revokeFileGrant(
                        {
                          project_id: projectId,
                          agent_id: grant.agent_id,
                          grant_id: grant.grant_id,
                        },
                      );
                      await refresh();
                    })
                  }
                >
                  <Button
                    aria-label={`Remove file grant for ${title(grant.target_project_id)}`}
                    icon={<Icon name="times" />}
                    disabled={busy}
                  />
                </Popconfirm>
              </div>
            );
          })
        )}
      </KeyboardBoundary>
    </Modal>
  );
}
