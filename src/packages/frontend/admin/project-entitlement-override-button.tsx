/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Typography,
  message,
} from "antd";
import { useCallback, useState } from "react";

import type { ProjectEntitlementOverride } from "@cocalc/conat/hub/api/projects";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { humanSize } from "@cocalc/util/misc";

const { Text } = Typography;

interface FormValues {
  disk_quota_mb: number;
  reason: string;
}

function diskQuotaMb(
  override?: ProjectEntitlementOverride | null,
): number | undefined {
  const value = override?.project_defaults?.disk_quota?.value;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function formatDiskQuota(mb?: number): string {
  if (mb == null) return "No project disk override is set.";
  return `Current project disk minimum: ${humanSize(mb * 1_000_000)} (${Math.ceil(mb)} MB).`;
}

export function ProjectEntitlementOverrideButton({
  project_id,
}: {
  project_id: string;
}) {
  const [form] = Form.useForm<FormValues>();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [override, setOverride] = useState<ProjectEntitlementOverride | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result =
        await webapp_client.conat_client.hub.projects.getAdminProjectEntitlementOverride(
          { project_id },
        );
      setOverride(result);
      const current = diskQuotaMb(result);
      form.setFieldsValue({
        disk_quota_mb: current,
        reason: result?.reason ?? "",
      });
    } catch (err) {
      setError(`${err}`);
    } finally {
      setLoading(false);
    }
  }, [form, project_id]);

  const show = useCallback(() => {
    setOpen(true);
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const values = await form.validateFields();
      const result =
        await webapp_client.conat_client.hub.projects.setAdminProjectEntitlementOverride(
          {
            project_id,
            disk_quota_mb: values.disk_quota_mb,
            reason: values.reason,
          },
        );
      setOverride(result);
      void message.success("Project disk override saved.");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setSaving(false);
    }
  }, [form, project_id]);

  const clear = useCallback(async () => {
    setClearing(true);
    setError(null);
    try {
      await webapp_client.conat_client.hub.projects.clearAdminProjectEntitlementOverride(
        {
          project_id,
          reason: "Admin cleared project disk override",
        },
      );
      setOverride(null);
      form.setFieldsValue({ disk_quota_mb: undefined, reason: "" });
      void message.success("Project disk override cleared.");
    } catch (err) {
      setError(`${err}`);
    } finally {
      setClearing(false);
    }
  }, [form, project_id]);

  const current = diskQuotaMb(override);

  return (
    <>
      <Button size="small" onClick={show}>
        Disk override
      </Button>
      <Modal
        title="Project disk override"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={save}
        okButtonProps={{ loading: saving }}
        okText="Save override"
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Text type="secondary">
            Set a project-specific minimum disk quota. Membership defaults still
            apply, but this project will not be started with less disk space
            than this override.
          </Text>
          {error ? <Alert type="error" showIcon message={error} /> : null}
          <Alert
            type={current == null ? "info" : "success"}
            showIcon
            message={
              loading ? "Loading current override..." : formatDiskQuota(current)
            }
          />
          <Form<FormValues> form={form} layout="vertical">
            <Form.Item
              label="Minimum disk quota"
              name="disk_quota_mb"
              rules={[
                { required: true, message: "Enter a disk quota." },
                {
                  type: "number",
                  min: 0,
                  message: "Disk quota must be nonnegative.",
                },
              ]}
              extra="Stored in MB. For example, 10240 is about 10 GB."
            >
              <InputNumber
                style={{ width: "100%" }}
                min={0}
                step={1024}
                addonAfter="MB"
              />
            </Form.Item>
            <Form.Item
              label="Reason"
              name="reason"
              rules={[{ required: true, message: "Enter a reason." }]}
            >
              <Input.TextArea rows={3} />
            </Form.Item>
          </Form>
          <Button
            danger
            loading={clearing}
            onClick={clear}
            disabled={!override}
          >
            Clear override
          </Button>
        </Space>
      </Modal>
    </>
  );
}
