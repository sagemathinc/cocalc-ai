import { Collapse, Form, Input } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import type { FormInstance } from "antd/es/form";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { HostCreateAdvancedFields } from "./host-create-advanced-fields";
import { HostCreateProviderFields } from "./host-create-provider-fields";
import { SshTargetLabel } from "./ssh-target-help";

type HostCreateFormProps = {
  form: FormInstance;
  canCreateHosts: boolean;
  provider: HostCreateViewModel["provider"];
  onProviderChange?: (value: string) => void;
  wrapForm?: boolean;
};

export const HostCreateForm: React.FC<HostCreateFormProps> = ({
  form,
  canCreateHosts,
  provider,
  onProviderChange,
  wrapForm = true,
}) => {
  const hideAdvanced = provider.selectedProvider === "self-host";
  const selfHostAlphaEnabled = !!useTypedRedux(
    "customize",
    "project_hosts_self_host_alpha_enabled",
  );
  const simpleSelfHost =
    provider.selectedProvider === "self-host" && !selfHostAlphaEnabled;
  const watchedSshTarget = Form.useWatch("self_host_ssh_target", form);
  React.useEffect(() => {
    if (!simpleSelfHost) return;
    if (form.getFieldValue("provider") !== "self-host") {
      form.setFieldsValue({ provider: "self-host" });
    }
    if (form.getFieldValue("self_host_kind") !== "direct") {
      form.setFieldsValue({ self_host_kind: "direct" });
    }
    if (form.getFieldValue("self_host_mode") !== "local") {
      form.setFieldsValue({ self_host_mode: "local" });
    }
    if (form.getFieldValue("disk") == null) {
      form.setFieldsValue({ disk: 100 });
    }
  }, [form, simpleSelfHost]);
  React.useEffect(() => {
    if (!simpleSelfHost) return;
    const nextName = (watchedSshTarget ?? "").trim();
    if (!nextName) return;
    if (form.getFieldValue("name") !== nextName) {
      form.setFieldsValue({ name: nextName });
    }
  }, [form, simpleSelfHost, watchedSshTarget]);
  const content = (
    <>
      {simpleSelfHost ? (
        <>
          <Form.Item name="provider" initialValue="self-host" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="name" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="self_host_kind" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="self_host_mode" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="disk" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="self_host_ssh_target"
            label={<SshTargetLabel label="Host" />}
            rules={[
              {
                required: true,
                message: "Please enter a host (user@host[:port]).",
              },
            ]}
          >
            <Input placeholder="user@host[:port] or ssh-config name" />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item name="name" label="Name" initialValue="My host">
            <Input placeholder="My host" />
          </Form.Item>
          <HostCreateProviderFields
            provider={provider}
            onProviderChange={onProviderChange}
          />
        </>
      )}
      {!hideAdvanced && (
        <Collapse ghost style={{ marginBottom: 8 }}>
          <Collapse.Panel header="Advanced options" key="adv">
            <HostCreateAdvancedFields provider={provider} />
          </Collapse.Panel>
        </Collapse>
      )}
    </>
  );
  if (!wrapForm) return content;
  return (
    <Form
      layout="vertical"
      disabled={!canCreateHosts}
      form={form}
    >
      {content}
    </Form>
  );
};
