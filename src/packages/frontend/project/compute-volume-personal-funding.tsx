/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
} from "antd";
import type {
  VolumePersonalFundingApi,
  VolumePersonalFundingConsent,
  VolumePersonalFundingPreview,
} from "@cocalc/util/compute-volume-personal-funding";
import { moneyToCurrency } from "@cocalc/util/money";
import { uuid } from "@cocalc/util/misc";
import { Icon } from "@cocalc/frontend/components/icon";
import { FinancialApprovalLink } from "@cocalc/frontend/purchases/financial-approval-link";

export default function VolumePersonalFunding({
  volumeId,
  fundingVersion,
  api,
  canSwitch = true,
}: {
  volumeId: string;
  fundingVersion: string;
  api: VolumePersonalFundingApi;
  canSwitch?: boolean;
}) {
  const [consent, setConsent] = useState<VolumePersonalFundingConsent | null>();
  const [preview, setPreview] = useState<VolumePersonalFundingPreview>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const operation = useRef<string | undefined>(undefined);
  const actionId = useRef<{ key: string; id: string } | undefined>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setConsent(undefined);
    setLoadError("");
    actionId.current = undefined;
  }, [volumeId]);
  useEffect(() => {
    generation.current++;
    setPreview(undefined);
    operation.current = undefined;
    setBusy(false);
    setError("");
  }, [volumeId, fundingVersion, canSwitch]);
  useEffect(() => {
    let active = true,
      loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      const revision = generation.current;
      try {
        const next = await api.getVolumePersonalFunding({
          volume_id: volumeId,
        });
        if (active && revision === generation.current) {
          setConsent(next);
          setLoadError("");
        }
      } catch (e) {
        if (active && revision === generation.current) setLoadError(String(e));
      } finally {
        loading = false;
      }
    };
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
  }, [api, volumeId]);
  const invalidate = () => {
    generation.current++;
    setPreview(undefined);
    operation.current = undefined;
    setBusy(false);
    setError("");
  };
  useEffect(() => {
    if (preview) heading.current?.focus();
  }, [preview]);
  const outstanding =
    consent &&
    ["pending", "approved", "preparing", "active"].includes(consent.state);
  const blocked = consent === undefined || !!loadError;
  const previewStale =
    !preview ||
    !Number.isFinite(Date.parse(preview.as_of)) ||
    now - Date.parse(preview.as_of) > 45_000;
  async function requestPreview(values: {
    lane: "prepaid" | "postpaid";
    cap_usd: string;
    ends_at: string;
  }) {
    const revision = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const end = new Date(values.ends_at);
      if (!Number.isFinite(end.valueOf()) || end.valueOf() <= Date.now())
        throw Error("Choose a future storage end time.");
      const next = await api.previewVolumePersonalFunding({
        terms: {
          ...values,
          volume_id: volumeId,
          expected_funding_version: fundingVersion,
          cap_usd: String(values.cap_usd),
          ends_at: end.toISOString(),
        },
      });
      if (revision === generation.current) {
        setPreview(next);
        operation.current = uuid();
      }
    } catch (e) {
      if (revision === generation.current) setError(String(e));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  }
  async function act(action: "propose" | "apply" | "cancel") {
    const revision = ++generation.current;
    setBusy(true);
    setError("");
    try {
      let next: VolumePersonalFundingConsent;
      if (action === "propose") {
        if (
          !preview ||
          !operation.current ||
          !Number.isFinite(Date.parse(preview.as_of)) ||
          Date.now() - Date.parse(preview.as_of) > 45_000
        )
          throw Error("Preview again before requesting approval.");
        next = await api.proposeVolumePersonalFunding({
          operation_id: operation.current,
          terms: preview.terms,
        });
      } else {
        if (!consent) return;
        const key = `${action}:${consent.id}:${consent.version}`;
        if (actionId.current?.key !== key)
          actionId.current = { key, id: uuid() };
        const opts = {
          volume_id: volumeId,
          consent_id: consent.id,
          expected_version: consent.version,
          operation_id: actionId.current.id,
        };
        next =
          action === "apply"
            ? await api.switchVolumePersonalFunding(opts)
            : await api.clearVolumePersonalFunding(opts);
      }
      if (revision === generation.current) {
        generation.current++;
        setConsent(next);
        setPreview(undefined);
        setBusy(false);
      }
    } catch (e) {
      if (revision === generation.current) setError(String(e));
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Personal storage funding" style={{ marginTop: 16 }}>
      <h4>Retain with my credit</h4>
      <p>
        This approval covers only this disk at its current size, not a VM or
        GPU. Storage and cleanup share one additional personal limit.
      </p>
      {loadError && <Alert type="error" showIcon title={loadError} />}
      {consent && (
        <div role="status">
          <p>Storage authorization: {consent.state}</p>
          <Descriptions
            size="small"
            column={1}
            layout="vertical"
            items={[
              {
                key: "cap",
                label: "Additional personal limit",
                children: moneyToCurrency(consent.terms.cap_usd),
              },
              {
                key: "spent",
                label: "Spent",
                children: moneyToCurrency(consent.spent_usd),
              },
              {
                key: "end",
                label: "Funding ends",
                children: new Date(consent.terms.ends_at).toLocaleString(),
              },
            ]}
          />
          <Space wrap style={{ maxWidth: "100%" }}>
            {consent.state === "pending" && consent.approval_url && (
              <Alert
                type="warning"
                showIcon
                title="Authorization required"
                description={
                  <FinancialApprovalLink
                    approvalUrl={consent.approval_url}
                    buttonProps={{ type: "primary" }}
                  >
                    Authorize
                  </FinancialApprovalLink>
                }
              />
            )}
            {consent.state === "approved" && (
              <Button
                disabled={
                  busy ||
                  blocked ||
                  !canSwitch ||
                  consent.terms.expected_funding_version !== fundingVersion
                }
                onClick={() => void act("apply")}
                style={{ whiteSpace: "normal", height: "auto", minHeight: 32 }}
                icon={<Icon name="credit-card" />}
              >
                Apply approved storage funding
              </Button>
            )}
            {outstanding && (
              <Button
                disabled={busy || blocked}
                onClick={() => void act("cancel")}
                style={{ whiteSpace: "normal", height: "auto", minHeight: 32 }}
                icon={<Icon name="stop" />}
              >
                Cancel storage authorization
              </Button>
            )}
          </Space>
        </div>
      )}
      {!canSwitch && (
        <Alert
          type="info"
          showIcon
          title="Detach this disk before changing its funding. Existing authorization can still be cancelled."
        />
      )}
      {!outstanding && canSwitch && (
        <Form
          layout="vertical"
          initialValues={{ lane: "prepaid" }}
          onFinish={requestPreview}
          onValuesChange={invalidate}
          disabled={busy || blocked}
        >
          <Form.Item
            name="lane"
            label="Storage funding"
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
            label="Additional storage limit (USD)"
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
            label="Storage funding ends"
            rules={[{ required: true }]}
          >
            <Input type="datetime-local" />
          </Form.Item>
          <Button
            htmlType="submit"
            loading={busy}
            disabled={blocked}
            icon={<Icon name="eye" />}
          >
            Preview storage funding
          </Button>
        </Form>
      )}
      {preview && (
        <section aria-label="Personal storage preview">
          <h5 ref={heading} tabIndex={-1}>
            Personal storage preview
          </h5>
          <Descriptions
            size="small"
            column={1}
            layout="vertical"
            items={[
              { key: "disk", label: "Volume", children: preview.volume_name },
              { key: "size", label: "Size", children: `${preview.size_gb} GB` },
              {
                key: "rate",
                label: "Hourly rate",
                children: moneyToCurrency(preview.hourly_usd, 4),
              },
              {
                key: "cap",
                label: "Additional personal limit",
                children: moneyToCurrency(preview.terms.cap_usd),
              },
              {
                key: "reserve",
                label: "Protected storage and cleanup",
                children: moneyToCurrency(preview.protected_storage_usd),
              },
              {
                key: "delete",
                label: "Latest deletion",
                children: new Date(preview.storage_delete_at).toLocaleString(),
              },
            ]}
          />
          <Button
            style={{ whiteSpace: "normal", height: "auto", minHeight: 32 }}
            onClick={() => void act("propose")}
            disabled={
              busy || blocked || !canSwitch || !!outstanding || previewStale
            }
            icon={<Icon name="external-link" />}
          >
            Authorize
          </Button>
        </section>
      )}
      <p>
        Cancellation prevents new authorization, not charges already incurred or
        reserved cleanup. Copy out important data before deletion. No automatic
        backup is made.
      </p>
      {error && <Alert type="error" showIcon title={error} />}
    </section>
  );
}
