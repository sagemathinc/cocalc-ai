import { Alert, Button, Modal, Select, Space, Typography } from "antd";
import { useId, useState } from "react";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export function TransferOwnership({
  project_id,
  owner_account_id,
  collaborators,
}: {
  project_id: string;
  owner_account_id: string;
  collaborators: { account_id: string; name: string }[];
}) {
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();

  async function transfer() {
    if (!target || saving) return;
    setSaving(true);
    setError("");
    try {
      const completed = await runFreshAuthAction(async () => {
        await webapp_client.conat_client.hub.projects.transferProjectOwnership({
          project_id,
          from_account_id: owner_account_id,
          to_account_id: target,
          browser_id: webapp_client.conat_client.client.browser_id,
        });
      });
      if (completed) setOpen(false);
    } catch (err) {
      setError(`${(err as Error)?.message ?? err}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        onClick={() => {
          setTarget(undefined);
          setError("");
          setOpen(true);
        }}
      >
        Transfer ownership
      </Button>
      <Modal
        title="Transfer project ownership"
        open={open}
        onCancel={() => {
          if (!saving) setOpen(false);
        }}
        onOk={() => void transfer()}
        okText="Confirm ownership transfer"
        confirmLoading={saving}
        okButtonProps={{
          disabled: !collaborators.some((c) => c.account_id === target),
        }}
        cancelButtonProps={{ disabled: saving }}
        closable={!saving}
        mask={{ closable: false }}
        modalRender={(modal) => <KeyboardBoundary>{modal}</KeyboardBoundary>}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Paragraph>
            Choose an existing collaborator to become the owner. You will remain
            a collaborator but lose owner-only controls. Only the new owner or
            an administrator can transfer ownership back.
          </Typography.Paragraph>
          <Alert
            type="warning"
            showIcon
            title="Review billing responsibility"
            description="Usage billing and runtime sponsorship assigned to the current owner will move to the new owner. Separately assigned payers are unchanged. This does not move project files or change the project host."
          />
          <Typography.Paragraph>
            Confirm with the recipient that their membership has room for this
            project and its storage/runtime needs. Their project allowance is
            checked before transfer; this does not reserve storage or runtime
            capacity.
          </Typography.Paragraph>
          <label id={labelId}>New owner</label>
          <Select
            aria-labelledby={labelId}
            style={{ width: "100%" }}
            value={target}
            onChange={setTarget}
            disabled={saving}
            options={collaborators.map(({ account_id, name }) => ({
              value: account_id,
              label: `${name} (${account_id})`,
            }))}
            placeholder="Choose an existing collaborator"
            showSearch={{ optionFilterProp: "label" }}
          />
          {collaborators.length === 0 && (
            <p>Add a collaborator before transferring ownership.</p>
          )}
          {error && (
            <Alert
              type="error"
              title={error}
              aria-label="Ownership transfer failed"
            />
          )}
        </Space>
      </Modal>
      <FreshAuthModal {...freshAuthModalProps} />
    </>
  );
}
