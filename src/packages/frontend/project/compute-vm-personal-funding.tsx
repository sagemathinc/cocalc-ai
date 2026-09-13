/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";
import type {
  VmPersonalFundingApi,
  VmPersonalFundingConsent,
  VmPersonalFundingPreview,
  VmPersonalFundingTerms,
} from "@cocalc/util/compute-vm-funding";
import { uuid } from "@cocalc/util/misc";
import { moneyToCurrency } from "@cocalc/util/money";
import { Icon } from "@cocalc/frontend/components/icon";

type Values = Pick<
  VmPersonalFundingTerms,
  "lane" | "cap_usd" | "activation" | "fallback_reasons"
> & { ends_at: string };

export default function VmPersonalFunding({
  vmId,
  fundingVersion,
  homeVolumeIds,
  api,
  onChange,
}: {
  vmId: string;
  fundingVersion: string;
  homeVolumeIds: string[];
  api: VmPersonalFundingApi;
  onChange?: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState<VmPersonalFundingPreview>();
  const [consent, setConsent] = useState<VmPersonalFundingConsent | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const consentRevision = useRef(0);
  const operation = useRef<string | undefined>(undefined);
  const actionOperation = useRef<{ key: string; id: string } | undefined>(
    undefined,
  );
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const activation = Form.useWatch("activation", form);
  const volumeKey = JSON.stringify([...homeVolumeIds].sort());

  useEffect(() => {
    let active = true;
    let fetching = false;
    async function refresh() {
      if (fetching) return;
      fetching = true;
      const revision = consentRevision.current;
      try {
        const value = await api.getVmPersonalFunding({ vm_id: vmId });
        if (!active || revision !== consentRevision.current) return;
        if (consentRef.current?.state !== value?.state) onChange?.();
        setConsent(value);
        setLoadError("");
      } catch (err) {
        if (active && revision === consentRevision.current)
          setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        fetching = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
      generation.current++;
    };
  }, [api, vmId, onChange]);

  useEffect(() => {
    generation.current++;
    setPreview(undefined);
    setBusy(false);
    operation.current = undefined;
  }, [fundingVersion, volumeKey]);

  useEffect(() => {
    if (preview) previewHeading.current?.focus();
  }, [preview]);

  function invalidate() {
    generation.current++;
    setPreview(undefined);
    setBusy(false);
    setError("");
    operation.current = undefined;
  }

  async function getPreview(values: Values) {
    const current = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const endsAt = new Date(values.ends_at);
      if (!Number.isFinite(endsAt.getTime()) || endsAt.getTime() <= Date.now())
        throw Error("Choose an end time in the future.");
      const terms: VmPersonalFundingTerms = {
        ...values,
        vm_id: vmId,
        expected_funding_version: fundingVersion,
        home_volume_ids: JSON.parse(volumeKey),
        cap_usd: String(values.cap_usd),
        ends_at: endsAt.toISOString(),
        fallback_reasons:
          values.activation === "fallback" ? values.fallback_reasons : [],
      };
      if (terms.activation === "fallback" && !terms.fallback_reasons?.length)
        throw Error("Select at least one reason for fallback.");
      const next = await api.previewVmPersonalFunding({ terms });
      if (current === generation.current) {
        setPreview(next);
        operation.current = uuid();
      }
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function propose() {
    if (!preview || !operation.current) return;
    consentRevision.current++;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.proposeVmPersonalFunding({
        operation_id: operation.current,
        terms: preview.terms,
      });
      if (current === generation.current) {
        consentRevision.current++;
        setConsent(next);
        setPreview(undefined);
      }
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function changeConsent(action: "cancel" | "apply") {
    if (!consent) return;
    consentRevision.current++;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const key = `${action}:${consent.id}:${consent.version}`;
      if (actionOperation.current?.key !== key)
        actionOperation.current = { key, id: uuid() };
      const opts = {
        vm_id: vmId,
        consent_id: consent.id,
        expected_version: consent.version,
        operation_id: actionOperation.current.id,
      };
      const next =
        action === "cancel"
          ? await api.clearVmPersonalFunding(opts)
          : await api.switchVmPersonalFunding({
              ...opts,
              expected_funding_version: fundingVersion,
            });
      if (current === generation.current) {
        consentRevision.current++;
        setConsent(next);
        onChange?.();
      }
    } catch (err) {
      if (current === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  const outstanding =
    consent &&
    ["pending", "approved", "preparing", "active"].includes(consent.state);
  const previewTime = preview ? Date.parse(preview.as_of) : NaN;
  const previewStale =
    !Number.isFinite(previewTime) || now - previewTime > 45_000;
  const blocked = !!loadError || consent === undefined || !!outstanding;
  return (
    <section aria-label="Personal VM funding" style={{ marginBottom: 16 }}>
      <Button
        icon={<Icon name="credit-card" />}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        Personal funding options
      </Button>
      {loadError && <Alert type="error" showIcon title={loadError} />}
      {consent && (
        <div role="status">
          <Typography.Paragraph>
            {consent.state === "preparing"
              ? "Switching to personal funding: waiting for VM stop and final usage accounting."
              : `Personal authorization: ${consent.state}`}
          </Typography.Paragraph>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="Additional personal cap">
              {moneyToCurrency(consent.terms.cap_usd)}
            </Descriptions.Item>
            <Descriptions.Item label="Personal spending">
              {moneyToCurrency(consent.spent_usd)}
            </Descriptions.Item>
            <Descriptions.Item label="Ends">
              {new Date(consent.terms.ends_at).toLocaleString()}
            </Descriptions.Item>
          </Descriptions>
          {consent.state === "pending" && consent.approval_url && (
            <Button
              type="primary"
              style={{
                whiteSpace: "normal",
                height: "auto",
                minHeight: 32,
                maxWidth: "100%",
              }}
              href={consent.approval_url}
              target="_blank"
              rel="noopener noreferrer"
              icon={<Icon name="external-link" />}
            >
              Review personal funding and authorize
            </Button>
          )}
          {outstanding && (
            <Button
              style={{
                whiteSpace: "normal",
                height: "auto",
                minHeight: 32,
                maxWidth: "100%",
              }}
              onClick={() => void changeConsent("cancel")}
              disabled={busy || !!loadError}
              icon={<Icon name="stop" />}
            >
              Cancel personal authorization
            </Button>
          )}
          {consent.state === "approved" &&
            consent.terms.activation === "immediate" && (
              <Button
                type="primary"
                style={{
                  whiteSpace: "normal",
                  height: "auto",
                  minHeight: 32,
                  maxWidth: "100%",
                }}
                onClick={() => void changeConsent("apply")}
                disabled={
                  busy ||
                  !!loadError ||
                  consent.terms.expected_funding_version !== fundingVersion
                }
                icon={<Icon name="credit-card" />}
              >
                Apply approved personal funding
              </Button>
            )}
        </div>
      )}
      {expanded && (
        <>
          <Typography.Paragraph>
            Personal charges require a separate approval. Your cap includes
            compute, network, and protected storage. Cancelling prevents further
            authorization; it does not erase charges or existing storage
            commitments.
          </Typography.Paragraph>
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              lane: "prepaid",
              activation: "immediate",
              fallback_reasons: [],
              cap_usd: undefined,
            }}
            onValuesChange={invalidate}
            onFinish={getPreview}
            disabled={busy || blocked}
          >
            <Form.Item
              name="lane"
              label="Personal funding"
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: "prepaid", label: "My prepaid credit" },
                  { value: "postpaid", label: "My eligible postpaid capacity" },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="cap_usd"
              label="Additional personal limit (USD)"
              rules={[{ required: true }]}
            >
              <InputNumber
                stringMode
                min="0.01"
                step="1"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item
              name="ends_at"
              label="Personal funding ends"
              rules={[{ required: true }]}
            >
              <Input type="datetime-local" />
            </Form.Item>
            <Form.Item name="activation" label="When to use personal funding">
              <Select
                options={[
                  { value: "immediate", label: "Switch after approval" },
                  { value: "fallback", label: "Only when course funding ends" },
                ]}
              />
            </Form.Item>
            {activation === "fallback" && (
              <Form.Item
                name="fallback_reasons"
                label="Allowed fallback reasons"
              >
                <Checkbox.Group
                  options={[
                    {
                      value: "course_exhausted",
                      label: "Course credit is exhausted",
                    },
                    {
                      value: "course_expired",
                      label: "Course allowance expires",
                    },
                  ]}
                />
              </Form.Item>
            )}
            <Button
              htmlType="submit"
              loading={busy}
              disabled={blocked}
              icon={<Icon name="eye" />}
            >
              Preview personal funding
            </Button>
          </Form>
          {preview && (
            <section aria-label="Personal funding preview">
              <h5 ref={previewHeading} tabIndex={-1}>
                Personal funding preview
              </h5>
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="Additional personal cap">
                  {moneyToCurrency(preview.terms.cap_usd)}
                </Descriptions.Item>
                <Descriptions.Item label="Current hourly rate">
                  {moneyToCurrency(preview.hourly_usd)}
                </Descriptions.Item>
                <Descriptions.Item label="Protected storage">
                  {moneyToCurrency(preview.protected_storage_usd)}
                </Descriptions.Item>
                <Descriptions.Item label="Maximum network charge">
                  {moneyToCurrency(preview.egress_cap_usd)}
                </Descriptions.Item>
                <Descriptions.Item label="Ends">
                  {new Date(preview.terms.ends_at).toLocaleString()}
                </Descriptions.Item>
              </Descriptions>
              {(preview.home_volumes ?? []).map((volume) => (
                <section
                  key={volume.id}
                  aria-label={`Personal storage: ${volume.name}`}
                >
                  <Typography.Text strong>{volume.name}</Typography.Text>
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Home volume hourly rate">
                      {moneyToCurrency(volume.hourly_usd, 4)}
                    </Descriptions.Item>
                    <Descriptions.Item label="Latest storage deletion">
                      {volume.storage_delete_at
                        ? new Date(volume.storage_delete_at).toLocaleString()
                        : "Existing policy; unchanged"}
                    </Descriptions.Item>
                  </Descriptions>
                  <Typography.Paragraph>
                    Deleting the VM does not delete this disk.{" "}
                    {volume.funding_action === "preserve"
                      ? "Its personal funding is unchanged and outside this VM cap. This approval does not extend or cancel the disk's existing agreement."
                      : "Storage uses the same personal cap and continues under its own funding deadline."}{" "}
                    VM files are not automatically backed up.
                  </Typography.Paragraph>
                </section>
              ))}
              {previewStale && (
                <Alert
                  type="warning"
                  title="Preview is out of date. Preview again before requesting approval."
                />
              )}
              <Space wrap>
                <Button
                  type="primary"
                  onClick={() => void propose()}
                  loading={busy}
                  disabled={blocked || previewStale}
                  icon={<Icon name="external-link" />}
                >
                  Request personal authorization
                </Button>
              </Space>
            </section>
          )}
        </>
      )}
      {error && <Alert type="error" showIcon title={error} />}
    </section>
  );
}
