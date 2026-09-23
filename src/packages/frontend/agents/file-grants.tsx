/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Typography,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  normalizeAgentFileGrantRoots,
  type AgentFileGrant,
} from "@cocalc/conat/agents/file-grants";
import { fileGrantsForAgent } from "./file-grants-service";

export interface FileGrantsProps {
  projectId: string;
  path: string;
  threadId: string;
  open: boolean;
  onClose: () => void;
  onCountChange?: (count: number) => void;
}

export function FileGrants(props: FileGrantsProps) {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? (
    <FileGrantsContents
      key={`${accountId}:${props.threadId}`}
      {...props}
      accountId={accountId}
    />
  ) : null;
}

function FileGrantsContents({
  accountId,
  projectId,
  path,
  threadId,
  open,
  onClose,
  onCountChange,
}: FileGrantsProps & { accountId: string }) {
  const projectMap: any = useTypedRedux("projects", "project_map");
  const [agentId, setAgentId] = useState<string>();
  const [grants, setGrants] = useState<AgentFileGrant[]>([]);
  const [targetProjectId, setTargetProjectId] = useState<string>();
  const [roots, setRoots] = useState(".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const projects = useMemo(() => {
    const rows: { value: string; label: string }[] = [];
    projectMap?.forEach?.((project: any, id: string) => {
      if (id === projectId || project?.get?.("deleted")) return;
      const users = project?.get?.("users");
      const membership = users?.get?.(accountId) ?? users?.[accountId];
      const group = membership?.get?.("group") ?? membership?.group;
      if (group !== "owner" && group !== "collaborator") return;
      const title = `${project?.get?.("title") ?? id}`.trim() || id;
      rows.push({ value: id, label: `${title} (${id.slice(0, 8)})` });
    });
    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [accountId, projectMap, projectId]);

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
    let disposed = false;
    setBusy(true);
    setError("");
    void fileGrantsForAgent({ projectId, path, threadId })
      .then(({ agentId, grants }) => {
        if (disposed) return;
        setAgentId(agentId);
        setGrants(grants);
        onCountChange?.(grants.length);
      })
      .catch((err) => !disposed && setError(String(err)))
      .finally(() => !disposed && setBusy(false));
    return () => {
      disposed = true;
    };
  }, [open, path, projectId, threadId, onCountChange]);

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
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 12 }}
          title="Read-only access for this agent"
          description="Access is checked for every operation and ends when the agent run ends. While a run is active, processes and collaborators in the source project may be able to use its runtime credential."
        />
        <Form layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item label="Project" htmlFor="file-grant-project">
            <Select
              id="file-grant-project"
              showSearch
              optionFilterProp="label"
              value={targetProjectId}
              options={projects}
              placeholder="Select another project"
              onChange={(value) => {
                setTargetProjectId(value);
                const existing = grants.find(
                  (grant) => grant.target_project_id === value,
                );
                setRoots(
                  existing?.roots.map((root) => root || ".").join("\n") ?? ".",
                );
              }}
            />
          </Form.Item>
          <Form.Item
            label="Readable paths"
            htmlFor="file-grant-roots"
            extra="One literal project-home-relative file or directory per line. Directories include their full tree. Use . for the project home; snapshots, SSH files, and CoCalc runtime credentials always stay excluded."
          >
            <Input.TextArea
              id="file-grant-roots"
              rows={4}
              value={roots}
              onChange={(event) => setRoots(event.target.value)}
              placeholder={"docs\nsrc/shared"}
            />
          </Form.Item>
          <Button
            type="primary"
            icon={<Icon name="plus" />}
            disabled={!targetProjectId || busy}
            onClick={() =>
              void run(async () => {
                const identity =
                  agentId != null ? { agent_id: agentId } : await refresh(true);
                if (!identity) throw new Error("agent identity unavailable");
                await webapp_client.conat_client.hub.agent.saveFileGrant({
                  project_id: projectId,
                  agent_id: identity.agent_id,
                  target_project_id: targetProjectId!,
                  roots: normalizeAgentFileGrantRoots(
                    roots.split(/\r?\n/).filter((root) => root.trim()),
                  ),
                });
                await refresh();
                setNotice(
                  "Read access saved for this user and agent. It will be available on future turns.",
                );
              })
            }
          >
            Save read access
          </Button>
        </Form>
        <Typography.Title level={5}>Available on future turns</Typography.Title>
        {grants.length === 0 ? (
          <Typography.Paragraph type="secondary">
            No file grants configured.
          </Typography.Paragraph>
        ) : (
          grants.map((grant) => {
            const project = projects.find(
              (item) => item.value === grant.target_project_id,
            );
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
                  style={{ height: "auto", whiteSpace: "normal", flex: 1 }}
                  onClick={() => {
                    setTargetProjectId(grant.target_project_id);
                    setRoots(grant.roots.map((root) => root || ".").join("\n"));
                  }}
                >
                  {project?.label ?? grant.target_project_id}:{" "}
                  {grant.roots.map((root) => root || ".").join(", ")}
                </Button>
                <Popconfirm
                  title="Remove this file grant?"
                  description="New reads stop immediately. An operation already admitted may finish."
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
                    aria-label={`Remove file grant for ${project?.label ?? grant.target_project_id}`}
                    icon={<Icon name="times" />}
                    disabled={busy}
                  />
                </Popconfirm>
              </div>
            );
          })
        )}
        <Typography.Paragraph type="secondary">
          This is ordinary filesystem access within the listed roots. Files may
          change concurrently because project processes and collaborators can
          modify the target filesystem. CoCalc records grant configuration and
          revocation, but this initial version does not provide a complete
          per-file activity log or identify which source-project process used
          the shared runtime credential.
        </Typography.Paragraph>
      </KeyboardBoundary>
    </Modal>
  );
}
