/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Select, Space, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CODEX_MODELS,
  type CodexReasoningLevel,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import type { AccountState } from "./types";
import {
  CODEX_NEW_CHAT_MODE_OPTIONS,
  OTHER_SETTINGS_CODEX_NEW_CHAT_DEFAULTS,
  codexNewChatDefaultsEqual,
  getDefaultCodexNewChatDefaults,
  getStoredCodexNewChatDefaults,
  normalizeCodexNewChatDefaults,
  saveCodexNewChatDefaults,
  type CodexNewChatDefaults,
} from "@cocalc/frontend/chat/codex-defaults";

const { Paragraph, Text, Title } = Typography;

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

  useEffect(() => {
    setDraft(effectiveDefaults);
  }, [effectiveDefaults]);

  const reasoningOptions = useMemo(() => {
    const model =
      DEFAULT_CODEX_MODELS.find((entry) => entry.name === draft.model) ??
      DEFAULT_CODEX_MODELS[0];
    return (model?.reasoning ?? []).map((option: CodexReasoningLevel) => ({
      value: option.id,
      label: `${option.label}${option.default ? " (default)" : ""}`,
    }));
  }, [draft.model]);

  return (
    <div style={{ marginTop: 16, marginBottom: 16 }}>
      <Title level={5} style={{ marginBottom: 8 }}>
        New Codex chat defaults
      </Title>
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
            <Text type="secondary">Model</Text>
          </div>
          <Select
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
            <Text type="secondary">Reasoning</Text>
          </div>
          <Select
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
        <div>
          <div style={{ marginBottom: 4 }}>
            <Text type="secondary">Execution mode</Text>
          </div>
          <Select
            value={draft.sessionMode}
            style={{ width: "100%" }}
            options={CODEX_NEW_CHAT_MODE_OPTIONS}
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
      </div>
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
    </div>
  );
}
