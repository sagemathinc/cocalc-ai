import { Collapse, Form, Input, Select } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { FormInstance } from "antd/es/form";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { HostCreateAdvancedFields } from "./host-create-advanced-fields";
import { HostCreateProviderFields } from "./host-create-provider-fields";
import { SshTargetLabel } from "./ssh-target-help";

function defaultRestorePolicy(
  pricingModel: "on_demand" | "spot" | undefined,
): "none" | "immediate" {
  return pricingModel === "spot" ? "immediate" : "none";
}

type HostCreateFormProps = {
  form: FormInstance;
  canCreateHosts: boolean;
  provider: HostCreateViewModel["provider"];
  onProviderChange?: (value: string) => void;
  wrapForm?: boolean;
  showOnlyProviderSelect?: boolean;
};

export const HostCreateForm: React.FC<HostCreateFormProps> = ({
  form,
  canCreateHosts,
  provider,
  onProviderChange,
  wrapForm = true,
  showOnlyProviderSelect = false,
}) => {
  const isSelfHost = provider.selectedProvider === "self-host";
  const hideAdvanced = isSelfHost;
  const simpleSelfHost = isSelfHost;
  const showSpotFields =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host";
  const watchedPricingModel = Form.useWatch("pricing_model", form);
  const watchedSshTarget = Form.useWatch("self_host_ssh_target", form);
  const previousPricingModelRef = React.useRef<"on_demand" | "spot">(
    "on_demand",
  );
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
  React.useEffect(() => {
    if (!showSpotFields) return;
    const nextPricingModel =
      watchedPricingModel === "spot" ? "spot" : "on_demand";
    const previousPricingModel = previousPricingModelRef.current;
    const currentRestorePolicy = form.getFieldValue(
      "interruption_restore_policy",
    ) as "none" | "immediate" | undefined;
    const nextDefault = defaultRestorePolicy(nextPricingModel);
    const previousDefault = defaultRestorePolicy(previousPricingModel);
    if (
      currentRestorePolicy == null ||
      (nextPricingModel !== previousPricingModel &&
        currentRestorePolicy === previousDefault)
    ) {
      form.setFieldsValue({ interruption_restore_policy: nextDefault });
    }
    previousPricingModelRef.current = nextPricingModel;
  }, [form, showSpotFields, watchedPricingModel]);
  const providerField = (
    <Form.Item
      name="provider"
      label="Provider"
      initialValue={provider.providerOptions[0]?.value ?? "none"}
    >
      <Select options={provider.providerOptions} onChange={onProviderChange} />
    </Form.Item>
  );

  const content = (
    <>
      {providerField}
      {showOnlyProviderSelect ? null : (
        <>
          {simpleSelfHost ? (
            <>
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
              {showSpotFields && (
                <>
                  <Form.Item
                    name="pricing_model"
                    label="Pricing model"
                    initialValue="on_demand"
                  >
                    <Select
                      options={[
                        { value: "on_demand", label: "On-demand" },
                        { value: "spot", label: "Spot / interruptible" },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item
                    name="interruption_restore_policy"
                    label="Interruption restore"
                    initialValue="none"
                    tooltip="For spot hosts, immediately restoring the host is strongly preferred because users otherwise lose access until a backup restore or manual recovery."
                  >
                    <Select
                      options={[
                        { value: "immediate", label: "Restore immediately" },
                        { value: "none", label: "Do not auto-restore" },
                      ]}
                    />
                  </Form.Item>
                </>
              )}
              <HostCreateProviderFields
                provider={provider}
                onProviderChange={onProviderChange}
                hideProviderSelect
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
      )}
    </>
  );
  if (!wrapForm) return content;
  return (
    <Form layout="vertical" disabled={!canCreateHosts} form={form}>
      {content}
    </Form>
  );
};
