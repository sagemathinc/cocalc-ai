/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CODEX_SUBAGENTS_LABEL } from "./codex-labels";
import { Button, Popover, Select, Typography } from "antd";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS,
  MAX_CODEX_CONCURRENT_SUBAGENTS,
  normalizeCodexMaxConcurrentSubagents,
} from "@cocalc/util/ai/codex-subagent-concurrency";
export * from "@cocalc/util/ai/codex-subagent-concurrency";

const { Paragraph, Text } = Typography;

export function readCodexMaxConcurrentSubagents(
  otherSettings: { get?: (key: string) => unknown } | null | undefined,
): number | undefined {
  return normalizeCodexMaxConcurrentSubagents(
    otherSettings?.get?.(OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS),
  );
}

export function saveCodexMaxConcurrentSubagents(
  value: unknown,
): number | undefined {
  const normalized = normalizeCodexMaxConcurrentSubagents(value);
  redux
    .getActions("account")
    .set_other_settings(
      OTHER_SETTINGS_CODEX_MAX_CONCURRENT_SUBAGENTS,
      normalized ?? null,
    );
  return normalized;
}

export function CodexSubagentConcurrencyField({
  compact = false,
}: Readonly<{ compact?: boolean }>) {
  const otherSettings = useTypedRedux("account", "other_settings");
  const value = readCodexMaxConcurrentSubagents(otherSettings);
  const options = useMemo(
    () => [
      { value: "automatic", label: "Automatic (currently 3)" },
      ...Array.from({ length: MAX_CODEX_CONCURRENT_SUBAGENTS }, (_, index) => ({
        value: `${index + 1}`,
        label: `${index + 1}`,
      })),
    ],
    [],
  );

  return (
    <div
      style={{ marginTop: compact ? 0 : 16, marginBottom: compact ? 0 : 16 }}
    >
      <div style={{ marginBottom: 6 }}>
        <Text strong>{CODEX_SUBAGENTS_LABEL}</Text>{" "}
        <Text type="secondary">(Account-wide)</Text>
      </div>
      <Select
        aria-label="Maximum concurrent Codex subagents"
        value={value == null ? "automatic" : `${value}`}
        style={{ width: "100%", maxWidth: 320 }}
        options={options}
        onChange={(next) => saveCodexMaxConcurrentSubagents(next)}
      />
      <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
        Codex may use this many workers in parallel, in addition to the manager.
        Higher values can consume your Codex or API allowance much faster. A
        change applies when a Codex session is next loaded.
      </Paragraph>
    </div>
  );
}

export function CodexSubagentConcurrencyButton() {
  const otherSettings = useTypedRedux("account", "other_settings");
  const value = readCodexMaxConcurrentSubagents(otherSettings) ?? 3;
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => contentRef.current?.focus());
  }, [open]);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={setOpen}
      destroyOnHidden
      content={
        <div
          id={contentId}
          ref={contentRef}
          role="dialog"
          aria-label="Parallel subagents settings"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeAndRestoreFocus();
          }}
          style={{ width: 320, maxWidth: "min(320px, calc(100vw - 48px))" }}
        >
          <CodexSubagentConcurrencyField compact />
        </div>
      }
    >
      <Button
        ref={buttonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={contentId}
      >
        Parallel subagents: {value}
      </Button>
    </Popover>
  );
}
