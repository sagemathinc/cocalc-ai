/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CODEX_DEFAULTS_LABELS } from "./codex-labels";
import { Button, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CODEX_MODELS,
  DEFAULT_CODEX_MODEL_INFO,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import type { AccountState } from "./types";
import {
  OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS,
  codexNewChatDefaultsEqual,
  getDefaultCodexNewChatDefaults,
  getCodexNewChatModeOptions,
  getStoredCodexNewChatDefaults,
  normalizeCodexNewChatDefaults,
  saveCodexNewChatDefaults,
  type CodexNewChatDefaults,
} from "@cocalc/frontend/chat/codex-defaults";
import { CodexFullAccessNotice } from "@cocalc/frontend/chat/codex-full-access";
import { lite } from "@cocalc/frontend/lite";
import { Panel } from "@cocalc/frontend/antd-bootstrap";

const { Paragraph, Text } = Typography;

interface Props {
  other_settings: AccountState["other_settings"];
}

export function CodexDefaultsPanel({ other_settings }: Readonly<Props>) {
  const storedDefaults = useMemo(
    () =>
      getStoredCodexNewChatDefaults(
        other_settings?.get(OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS),
      ),
    [other_settings],
  );
  const effectiveDefaults = storedDefaults ?? getDefaultCodexNewChatDefaults();
  const [draft, setDraft] = useState<CodexNewChatDefaults>(effectiveDefaults);
  const builtInDefaults = useMemo(() => normalizeCodexNewChatDefaults({}), []);
  const { model, reasoning, serviceTier, sessionMode } = effectiveDefaults;

  // Normalization can return a new object without changing any saved values.
  // Only actual settings changes should replace an unsaved draft.
  useEffect(() => {
    setDraft({ model, reasoning, serviceTier, sessionMode });
  }, [model, reasoning, serviceTier, sessionMode]);

  const reasoningOptions = useMemo(() => {
    const model =
      DEFAULT_CODEX_MODELS.find((entry) => entry.name === draft.model) ??
      DEFAULT_CODEX_MODEL_INFO;
    return (model?.reasoning ?? []).map((option: CodexReasoningLevel) => ({
      value: option.id,
      label: `${option.label}${option.default ? " (default)" : ""}`,
    }));
  }, [draft.model]);

  return (
    <Panel header={CODEX_DEFAULTS_LABELS.title}>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Configure the model and execution settings used when you create a new
        Codex chat.
      </Paragraph>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">{CODEX_DEFAULTS_LABELS.model}</Text>
          </div>
          <Select
            aria-label="Default Codex model"
            value={draft.model}
            style={{ width: "100%" }}
            options={DEFAULT_CODEX_MODELS.map((model) => ({
              value: model.name,
              label: model.name,
            }))}
            onChange={(value) =>
              setDraft(
                normalizeCodexNewChatDefaults({
                  ...draft,
                  model: String(value),
                }),
              )
            }
          />
        </div>
        <div>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">{CODEX_DEFAULTS_LABELS.reasoning}</Text>
          </div>
          <Select
            aria-label="Default Codex reasoning level"
            value={draft.reasoning}
            style={{ width: "100%" }}
            options={reasoningOptions}
            onChange={(value) =>
              setDraft(
                normalizeCodexNewChatDefaults({
                  ...draft,
                  reasoning: value as CodexReasoningId,
                }),
              )
            }
          />
        </div>
        {lite ? (
          <div>
            <div style={{ marginBottom: 4 }}>
              <Text type="secondary">{CODEX_DEFAULTS_LABELS.execution}</Text>
            </div>
            <Select
              aria-label="Default Codex execution mode"
              value={draft.sessionMode}
              style={{ width: "100%" }}
              options={getCodexNewChatModeOptions()}
              onChange={(value) =>
                setDraft(
                  normalizeCodexNewChatDefaults({
                    ...draft,
                    sessionMode: value as CodexSessionMode,
                  }),
                )
              }
            />
          </div>
        ) : null}
      </div>
      {!lite ? (
        <div style={{ marginBottom: 12 }}>
          <CodexFullAccessNotice />
        </div>
      ) : null}
      <Space>
        <Button
          type="primary"
          disabled={codexNewChatDefaultsEqual(draft, effectiveDefaults)}
          onClick={() => {
            const saved = saveCodexNewChatDefaults(draft);
            setDraft(saved);
          }}
        >
          Save defaults
        </Button>
        <Button
          disabled={codexNewChatDefaultsEqual(
            effectiveDefaults,
            builtInDefaults,
          )}
          onClick={() => {
            const saved = saveCodexNewChatDefaults(builtInDefaults);
            setDraft(saved);
          }}
        >
          Reset to built-in defaults
        </Button>
      </Space>
    </Panel>
  );
}
