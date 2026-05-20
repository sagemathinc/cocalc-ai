import { Col, Collapse, Form, Input, Row, Select, Typography } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import type { DedicatedHostSurchargeSettings } from "@cocalc/util/project-host-pricing";
import { COLORS } from "@cocalc/util/theme";
import type { FormInstance } from "antd/es/form";
import type { HostCreateViewModel } from "../hooks/use-host-create-view-model";
import { isNebiusSpotSupported } from "../providers/registry";
import { defaultRestorePolicy } from "../utils/spot-recovery-policy";
import { HostCreateAdvancedFields } from "./host-create-advanced-fields";
import { HostCreateProviderFields } from "./host-create-provider-fields";
import { SshTargetLabel } from "./ssh-target-help";

const FIELD_GROUP_STYLE: React.CSSProperties = {
  background: COLORS.GRAY_LLL,
  border: `1px solid ${COLORS.GRAY_LL}`,
  borderRadius: 10,
  marginBottom: 8,
  padding: "8px 10px 0",
};

type HostCreateFormProps = {
  form: FormInstance;
  canCreateHosts: boolean;
  provider: HostCreateViewModel["provider"];
  billing?: HostCreateViewModel["billing"];
  onProviderChange?: (value: string) => void;
  wrapForm?: boolean;
  showOnlyProviderSelect?: boolean;
  hideProviderSelect?: boolean;
  autoSelectFundingMode?: boolean;
  pricingSettings?: DedicatedHostSurchargeSettings;
  onValuesChange?: (changedValues: any, allValues: any) => void;
  draftManaged?: boolean;
};

export const HostCreateForm: React.FC<HostCreateFormProps> = ({
  form,
  canCreateHosts,
  provider,
  billing,
  onProviderChange,
  wrapForm = true,
  showOnlyProviderSelect = false,
  hideProviderSelect = false,
  autoSelectFundingMode = true,
  pricingSettings,
  onValuesChange,
  draftManaged = false,
}) => {
  const isSelfHost = provider.selectedProvider === "self-host";
  const hideAdvanced = isSelfHost;
  const simpleSelfHost = isSelfHost;
  const showSpotFields =
    provider.selectedProvider !== "none" &&
    provider.selectedProvider !== "self-host";
  const watchedMachineType = Form.useWatch("machine_type", form);
  const watchedPricingModel = Form.useWatch("pricing_model", form);
  const watchedSshTarget = Form.useWatch("self_host_ssh_target", form);
  const watchedFundingMode = Form.useWatch("funding_mode", form);
  const nebiusSpotSupported = React.useMemo(
    () =>
      provider.selectedProvider !== "nebius" ||
      isNebiusSpotSupported(
        provider.fields.options.machine_type,
        watchedMachineType,
      ),
    [
      provider.fields.options.machine_type,
      provider.selectedProvider,
      watchedMachineType,
    ],
  );
  const previousPricingModelRef = React.useRef<"on_demand" | "spot">(
    "on_demand",
  );
  const updateDraftManagedFields = React.useCallback(
    (patch: Record<string, any>) => {
      onValuesChange?.(patch, { ...form.getFieldsValue(true), ...patch });
    },
    [form, onValuesChange],
  );
  const setFormFields = React.useCallback(
    (patch: Record<string, any>) => {
      form.setFieldsValue(patch);
      if (draftManaged) {
        updateDraftManagedFields(patch);
      }
    },
    [draftManaged, form, updateDraftManagedFields],
  );
  React.useEffect(() => {
    if (draftManaged) return;
    if (!simpleSelfHost) return;
    if (form.getFieldValue("provider") !== "self-host") {
      setFormFields({ provider: "self-host" });
    }
    if (form.getFieldValue("self_host_kind") !== "direct") {
      setFormFields({ self_host_kind: "direct" });
    }
    if (form.getFieldValue("self_host_mode") !== "local") {
      setFormFields({ self_host_mode: "local" });
    }
    if (form.getFieldValue("disk") == null) {
      setFormFields({ disk: 100, disk_gb: 100 });
    }
  }, [draftManaged, form, setFormFields, simpleSelfHost]);
  React.useEffect(() => {
    if (draftManaged) return;
    if (!simpleSelfHost) return;
    const nextName = (watchedSshTarget ?? "").trim();
    if (!nextName) return;
    if (form.getFieldValue("name") !== nextName) {
      setFormFields({ name: nextName });
    }
  }, [draftManaged, form, setFormFields, simpleSelfHost, watchedSshTarget]);
  React.useEffect(() => {
    if (draftManaged) return;
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
  }, [draftManaged, form, showSpotFields, watchedPricingModel]);
  React.useEffect(() => {
    if (draftManaged) return;
    if (provider.selectedProvider !== "nebius") return;
    if (nebiusSpotSupported) return;
    if (watchedPricingModel !== "spot") return;
    form.setFieldsValue({
      pricing_model: "on_demand",
      interruption_restore_policy: "none",
    });
  }, [
    form,
    nebiusSpotSupported,
    provider.selectedProvider,
    watchedPricingModel,
    draftManaged,
  ]);
  React.useEffect(() => {
    if (draftManaged) return;
    if (!autoSelectFundingMode || !showSpotFields) {
      return;
    }
    const defaultFundingMode =
      billing?.defaultFundingMode ?? billing?.fundingModeOptions?.[0]?.value;
    if (!defaultFundingMode) {
      return;
    }
    const isAllowed = billing?.fundingModeOptions?.some(
      (option) => option.value === watchedFundingMode,
    );
    if (!isAllowed) {
      form.setFieldsValue({ funding_mode: defaultFundingMode });
    }
  }, [
    autoSelectFundingMode,
    billing?.defaultFundingMode,
    billing?.fundingModeOptions,
    form,
    showSpotFields,
    watchedFundingMode,
    draftManaged,
  ]);
  const providerField = (
    <Form.Item
      name="provider"
      label="Provider"
      initialValue={
        draftManaged
          ? undefined
          : (provider.providerOptions[0]?.value ?? "none")
      }
    >
      <Select options={provider.providerOptions} onChange={onProviderChange} />
    </Form.Item>
  );

  const content = (
    <>
      {hideProviderSelect ? null : providerField}
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
              <Form.Item name="disk_gb" hidden>
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
              <div style={FIELD_GROUP_STYLE}>
                <Typography.Text strong>Basics and billing</Typography.Text>
                <Row gutter={[10, 0]} style={{ marginTop: 6 }}>
                  <Col xs={24} md={showSpotFields ? 12 : 24}>
                    <Form.Item
                      name="name"
                      label="Name"
                      initialValue={draftManaged ? undefined : "My host"}
                    >
                      <Input placeholder="My host" />
                    </Form.Item>
                  </Col>
                  {showSpotFields && (
                    <Col xs={24} md={12}>
                      <Form.Item
                        name="funding_mode"
                        label="Billing"
                        rules={[
                          {
                            required: true,
                            message:
                              "Please choose how this host will be funded.",
                          },
                        ]}
                      >
                        <Select options={billing?.fundingModeOptions ?? []} />
                      </Form.Item>
                    </Col>
                  )}
                </Row>
              </div>
              <HostCreateProviderFields
                provider={provider}
                onProviderChange={onProviderChange}
                hideProviderSelect
                draftManaged={draftManaged}
                onDraftPatch={updateDraftManagedFields}
              />
            </>
          )}
          {!hideAdvanced && (
            <Collapse
              ghost
              style={{ marginBottom: 8 }}
              items={[
                {
                  key: "adv",
                  label: "Advanced options",
                  forceRender: true,
                  children: (
                    <HostCreateAdvancedFields
                      provider={provider}
                      showSpotFields={showSpotFields}
                      nebiusSpotSupported={nebiusSpotSupported}
                      pricingSettings={pricingSettings}
                      draftManaged={draftManaged}
                      onDraftPatch={updateDraftManagedFields}
                    />
                  ),
                },
              ]}
            />
          )}
        </>
      )}
    </>
  );
  if (!wrapForm) return content;
  return (
    <Form
      layout="vertical"
      size="small"
      disabled={!canCreateHosts}
      form={form}
      onValuesChange={onValuesChange}
    >
      {content}
    </Form>
  );
};
