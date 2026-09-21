/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Typography,
} from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { ensureProjectDeployPublicKey } from "@cocalc/frontend/project/settings/project-to-project-ssh-service";
import { uuid } from "@cocalc/util/misc";
import type { ComputeVm } from "@cocalc/conat/hub/api/compute";
import {
  MAX_AGENT_VMS,
  MAX_VM_NOTES,
  readVmToolbox,
  VM_TOOLBOX_SETTING,
  vmToolboxAlias,
} from "./vm-toolbox-model";
import {
  assertToolboxAccount,
  currentVmToolbox,
  listToolboxVms,
  prepareVmSsh,
  probeVmSsh,
  saveVmToolbox,
} from "./vm-toolbox-service";

export interface VmToolboxProps {
  projectId: string;
  path: string;
  threadId: string;
  open: boolean;
  onClose: () => void;
}

export function VmToolbox(props: VmToolboxProps) {
  const accountId = useTypedRedux("account", "account_id");
  return accountId ? (
    <VmToolboxContents
      key={`${accountId}:${props.projectId}:${props.path}:${props.threadId}`}
      {...props}
      accountId={accountId}
    />
  ) : null;
}

function VmToolboxContents({
  projectId,
  path,
  threadId,
  open,
  onClose,
  accountId,
}: VmToolboxProps & { accountId: string }) {
  const settings = useTypedRedux("account", "other_settings");
  const [agentId, setAgentId] = useState<string>();
  const [vms, setVms] = useState<ComputeVm[]>([]);
  const [selected, setSelected] = useState<string>();
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  const bindings = readVmToolbox(settings?.get?.(VM_TOOLBOX_SETTING));
  const entries = bindings.find((item) => item.agentId === agentId)?.vms ?? [];
  const vm = vms.find((item) => item.id === selected);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    setBusy(true);
    setError("");
    void (async () => {
      const identity =
        await webapp_client.conat_client.hub.agent.resolveIdentity({
          project_id: projectId,
          path,
          thread_id: threadId,
        });
      const available = await listToolboxVms(projectId);
      if (disposed) return;
      setAgentId(identity?.agent_id);
      setVms(available);
    })()
      .catch((err) => {
        if (!disposed) setError(String(err));
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
    };
  }, [open, accountId, projectId, path, threadId]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      assertToolboxAccount(accountId);
      await action();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function attach() {
    if (!vm) return;
    const identity =
      await webapp_client.conat_client.hub.agent.registerIdentity({
        project_id: projectId,
        path,
        thread_id: threadId,
      });
    assertToolboxAccount(accountId);
    if (!identity) throw Error("Agent identity unavailable");
    setAgentId(identity.agent_id);
    const latest =
      currentVmToolbox().find((item) => item.agentId === identity.agent_id)
        ?.vms ?? [];
    const next = latest.filter((item) => item.vmId !== vm.id);
    if (next.length >= MAX_AGENT_VMS)
      throw Error(`At most ${MAX_AGENT_VMS} VMs per agent`);
    next.push({ vmId: vm.id, notes });
    await saveVmToolbox(accountId, {
      agentId: identity.agent_id,
      projectId,
      path,
      threadId,
      vms: next,
    });
    setNotice(
      "VM saved for your future turns with this agent. Other users have their own toolbox.",
    );
  }

  async function configure() {
    if (!vm) return;
    const attached =
      await webapp_client.conat_client.hub.compute.listProjectVms({
        project_id: projectId,
      });
    assertToolboxAccount(accountId);
    if (!attached.some((item) => item.id === vm.id)) {
      const done = await runFreshAuthAction(async () => {
        assertToolboxAccount(accountId);
        const key = await ensureProjectDeployPublicKey(projectId);
        assertToolboxAccount(accountId);
        await webapp_client.conat_client.hub.compute.grantVmProjectAccess({
          browser_id: webapp_client.browser_id,
          id_or_name: vm.id,
          project_id: projectId,
          ssh_public_key: key,
          idempotency_key: uuid(),
        });
      });
      if (!done) return false;
    }
    assertToolboxAccount(accountId);
    await prepareVmSsh(projectId, vm.id);
    setNotice(
      `Passwordless SSH verified at ${new Date().toLocaleTimeString()}.`,
    );
    return true;
  }

  return (
    <>
      <Modal
        title="Your VM toolbox"
        open={open}
        onCancel={onClose}
        footer={<Button onClick={onClose}>Done</Button>}
        width={640}
        destroyOnHidden
      >
        <KeyboardBoundary>
          {busy && (
            <div role="status" style={{ marginBottom: 12 }}>
              Working...
            </div>
          )}
          {error && (
            <Alert
              type="error"
              showIcon
              title="VM toolbox needs attention"
              description={error}
            />
          )}
          {notice && (
            <div role="status">
              <Alert type="success" showIcon title={notice} />
            </div>
          )}
          <Form layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item label="Virtual machine" htmlFor="toolbox-vm">
              <Select
                id="toolbox-vm"
                showSearch
                optionFilterProp="label"
                value={selected}
                loading={busy}
                placeholder="Select a virtual machine"
                options={vms.map((item) => ({
                  value: item.id,
                  label: `${item.name} (${item.state})`,
                }))}
                onChange={(id) => {
                  setSelected(id);
                  setNotes(
                    entries.find((item) => item.vmId === id)?.notes ?? "",
                  );
                  setNotice("");
                }}
              />
            </Form.Item>
            {vm && (
              <>
                <Typography.Paragraph>
                  <Typography.Text
                    code
                  >{`ssh ${vmToolboxAlias(vm.id)}`}</Typography.Text>
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary">
                  {vm.cpu} vCPU · {vm.ram_gb} GB RAM · {vm.boot_disk_gb} GB disk
                  · {vm.region}. Funding: {vm.funding_mode}.{" "}
                  {vm.expires_at
                    ? `Scheduled deletion: ${new Date(vm.expires_at).toLocaleString()}.`
                    : ""}
                </Typography.Paragraph>
              </>
            )}
            <Form.Item
              label="Instructions for this VM"
              htmlFor="toolbox-vm-notes"
              extra="Advisory notes, not enforced limits. Notes sent to the agent can appear in shared conversation context."
            >
              <Input.TextArea
                id="toolbox-vm-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={MAX_VM_NOTES}
                rows={3}
                placeholder="For example: feel free to install packages with sudo; please conserve disk space."
              />
            </Form.Item>
            <Space wrap>
              {entries.some((entry) => entry.vmId === selected) ? (
                <Button
                  type="primary"
                  disabled={!vm || busy}
                  onClick={() => void run(attach)}
                  icon={<Icon name="plus" />}
                >
                  Save to toolbox
                </Button>
              ) : (
                <Popconfirm
                  title="Configure SSH and add this VM?"
                  description="The source project's collaborators can use its SSH key. This VM stays in your toolbox for later turns."
                  onConfirm={() =>
                    run(async () => {
                      if (await configure()) await attach();
                    })
                  }
                >
                  <Button
                    type="primary"
                    disabled={!vm || vm.state !== "ready" || busy}
                    icon={<Icon name="plus" />}
                  >
                    Add VM
                  </Button>
                </Popconfirm>
              )}
              <Popconfirm
                title="Configure project SSH access?"
                description="Project collaborators can use this SSH access. It remains after removing the VM from this toolbox."
                onConfirm={() => run(configure)}
              >
                <Button disabled={!vm || vm.state !== "ready" || busy}>
                  Configure SSH
                </Button>
              </Popconfirm>
              <Button
                disabled={!vm || vm.state !== "ready" || busy}
                onClick={() =>
                  void run(async () => {
                    await probeVmSsh(projectId, vm!.id);
                    setNotice(
                      `Passwordless SSH verified at ${new Date().toLocaleTimeString()}.`,
                    );
                  })
                }
              >
                Check SSH
              </Button>
              {vm?.state === "stopped" && vm.owner_account_id === accountId && (
                <Popconfirm
                  title="Start this VM?"
                  description="Starting resumes charges using its existing funding."
                  onConfirm={() =>
                    run(async () => {
                      const done = await runFreshAuthAction(async () => {
                        assertToolboxAccount(accountId);
                        await webapp_client.conat_client.hub.compute.startVm({
                          id_or_name: vm.id,
                          browser_id: webapp_client.browser_id,
                          idempotency_key: uuid(),
                        });
                      });
                      if (done) {
                        setVms(await listToolboxVms(projectId));
                        setNotice(
                          "Start requested. Refresh status before configuring SSH.",
                        );
                      }
                    })
                  }
                >
                  <Button disabled={busy} icon={<Icon name="play" />}>
                    Start
                  </Button>
                </Popconfirm>
              )}
              <Button
                aria-label="Refresh VM status"
                disabled={busy}
                icon={<Icon name="refresh" />}
                onClick={() =>
                  void run(async () => setVms(await listToolboxVms(projectId)))
                }
              />
            </Space>
          </Form>
          <Typography.Title level={5}>
            Available on your next turns
          </Typography.Title>
          {entries.length === 0 ? (
            <Typography.Paragraph type="secondary">
              No VMs attached.
            </Typography.Paragraph>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.vmId}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  marginBottom: 8,
                }}
              >
                <Button
                  type="link"
                  style={{
                    whiteSpace: "normal",
                    height: "auto",
                    textAlign: "left",
                    flex: 1,
                  }}
                  onClick={() => {
                    setSelected(entry.vmId);
                    setNotes(entry.notes);
                  }}
                >
                  {vms.find((item) => item.id === entry.vmId)?.name ??
                    entry.vmId}
                </Button>
                <Button
                  aria-label={`Remove ${vms.find((item) => item.id === entry.vmId)?.name ?? entry.vmId} from toolbox`}
                  disabled={busy}
                  icon={<Icon name="times" />}
                  onClick={() =>
                    void run(async () => {
                      const binding = currentVmToolbox().find(
                        (item) => item.agentId === agentId,
                      );
                      if (binding)
                        await saveVmToolbox(accountId, {
                          ...binding,
                          vms: binding.vms.filter(
                            (item) => item.vmId !== entry.vmId,
                          ),
                        });
                    })
                  }
                />
              </div>
            ))
          )}
          <Typography.Paragraph type="secondary">
            Removing a VM here does not stop it or revoke project SSH access.
            SSH runs with the remote user's privileges; project keys are shared
            with project code.
          </Typography.Paragraph>
        </KeyboardBoundary>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
