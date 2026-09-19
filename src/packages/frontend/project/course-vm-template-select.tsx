import { useEffect, useRef, useState } from "react";
import { Alert, Select, Space, Typography } from "antd";
import type { ComputeCatalog } from "@cocalc/conat/hub/api/compute";
import type {
  CourseVmTemplate,
  CourseVmTemplateConfig,
} from "@cocalc/util/course-vm-template";
import { normalizeCourseVmTemplates } from "@cocalc/util/course-vm-template";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useHostPricingSettings } from "@cocalc/frontend/hosts/hooks/use-host-pricing-settings";
import {
  quoteCourseVmTemplate,
  templateHardwarePatch,
} from "@cocalc/frontend/course/course-vm-template-model";

export function CourseVmTemplateSelect({
  templates,
  sourceKey,
  fundingMode,
  disabled,
  onApply,
  onPendingChange,
  resetKey,
  defaultToFirst = false,
  getCatalog = () => webapp_client.conat_client.hub.compute.getCatalog({}),
}: {
  templates: CourseVmTemplate[];
  sourceKey: string;
  fundingMode?: string;
  disabled?: boolean;
  onApply: (config: CourseVmTemplateConfig, catalog: ComputeCatalog) => void;
  onPendingChange?: (pending: boolean) => void;
  resetKey?: number;
  defaultToFirst?: boolean;
  getCatalog?: () => Promise<ComputeCatalog>;
}) {
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [quote, setQuote] =
    useState<ReturnType<typeof quoteCourseVmTemplate>>();
  const [checkedAt, setCheckedAt] = useState<Date>();
  const request = useRef(0);
  const templateVersion = JSON.stringify(templates);
  const selectionIdentity = `${sourceKey}:${templateVersion}`;
  const previousSelectionIdentity = useRef(selectionIdentity);
  const previousResetKey = useRef(resetKey);
  const pricing = useHostPricingSettings();
  useEffect(() => {
    onPendingChange?.(busy);
  }, [busy, onPendingChange]);
  useEffect(() => () => onPendingChange?.(false), [onPendingChange]);
  async function choose(id: string, alternative?: CourseVmTemplateConfig) {
    const version = ++request.current;
    setSelected(id);
    setError("");
    setQuote(undefined);
    setCheckedAt(undefined);
    if (!id) {
      setBusy(false);
      return;
    }
    setBusy(true);
    try {
      const config =
        alternative ??
        normalizeCourseVmTemplates(templates).find((item) => item.id === id)
          ?.config;
      if (!config)
        throw new Error("This recommendation is no longer available.");
      const catalog = await getCatalog();
      if (request.current !== version) return;
      const next = quoteCourseVmTemplate(catalog, config, fundingMode, pricing);
      setQuote(next);
      setCheckedAt(new Date());
      if (!next.available) {
        setError(
          "This configuration is not currently offered. Your funding and VM configuration have not changed.",
        );
      } else if (!next.price) {
        setError(
          "Current pricing is unavailable. Your funding and VM configuration have not changed.",
        );
      } else {
        onApply(templateHardwarePatch(config), catalog);
      }
    } catch (err) {
      if (request.current === version)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request.current === version) setBusy(false);
    }
  }
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  useEffect(() => {
    request.current++;
    setSelected("");
    setError("");
    setQuote(undefined);
    setCheckedAt(undefined);
    setBusy(false);
    const first = templates[0];
    if (defaultToFirst && first) void chooseRef.current(first.id);
    return () => {
      request.current++;
    };
  }, [defaultToFirst, selectionIdentity]);
  useEffect(() => {
    if (previousSelectionIdentity.current !== selectionIdentity) {
      previousSelectionIdentity.current = selectionIdentity;
      previousResetKey.current = resetKey;
      return;
    }
    if (Object.is(previousResetKey.current, resetKey)) return;
    previousResetKey.current = resetKey;
    request.current++;
    setSelected("");
    setError("");
    setQuote(undefined);
    setCheckedAt(undefined);
    setBusy(false);
  }, [resetKey, selectionIdentity]);
  const recommendation = templates.find((item) => item.id === selected);
  return (
    <section
      aria-label="Course VM recommendations"
      style={{ marginBottom: 16 }}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Select
          aria-label="Recommended VM configuration"
          style={{ width: "100%" }}
          value={selected}
          loading={busy}
          disabled={disabled}
          options={[
            { value: "", label: "Custom configuration" },
            ...templates.map((item) => ({ value: item.id, label: item.label })),
          ]}
          onChange={(id) => void choose(id)}
        />
        {recommendation?.description && (
          <Typography.Paragraph style={{ margin: 0 }}>
            {recommendation.description}
          </Typography.Paragraph>
        )}
        {error && <Alert type="warning" showIcon title={error} />}
        {error && !!quote?.alternatives.length && (
          <Select
            aria-label="Currently offered alternatives"
            placeholder="Currently offered alternatives"
            style={{ width: "100%" }}
            disabled={disabled || busy}
            value={undefined}
            options={quote.alternatives.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            onChange={(key) => {
              const config = quote.alternatives.find(
                (item) => item.value === key,
              )?.config;
              if (config) void choose(selected, config);
            }}
          />
        )}
        {quote?.available && quote.price && (
          <Typography.Paragraph role="status" style={{ margin: 0 }}>
            Current estimate: {quote.price.hourly_label}. Checked{" "}
            {checkedAt?.toLocaleTimeString()}.
          </Typography.Paragraph>
        )}
      </Space>
    </section>
  );
}
