/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Input, Modal, Select, Space } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import { CSS } from "@cocalc/frontend/app-framework";
import { Icon, VisibleMDLG } from "@cocalc/frontend/components";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { labels } from "@cocalc/frontend/i18n";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { DEFAULT_CODEX_MODELS } from "@cocalc/util/ai/codex";
import { COLORS } from "@cocalc/util/theme";
import { BaseEditorActions as Actions } from "../base-editor/actions-base";
import {
  DEFAULT_ASSISTANT_CODEX_MODEL,
  Options,
  resolveAssistantCodexModel,
} from "./create-chat";

interface Props {
  id: string;
  path: string;
  type: string;
  actions: Actions;
  buttonSize;
  buttonStyle: CSS;
  visible?: boolean;
  buttonRef;
  project_id: string;
  showDialog: boolean;
  setShowDialog: (open: boolean) => void;
  noLabel?: boolean;
}

export default function LanguageModelTitleBarButton({
  id,
  path,
  type,
  actions,
  buttonSize,
  buttonStyle,
  visible,
  buttonRef,
  project_id,
  showDialog,
  setShowDialog,
  noLabel,
}: Props) {
  const intl = useIntl();
  const inputRef = useRef<any>(null);
  const submittingRef = useRef(false);
  const [error, setError] = useState<string>("");
  const [querying, setQuerying] = useState<boolean>(false);
  const [command, setCommand] = useState<string>("");

  const modelLsKey = `AI-CODEX-ASSISTANT-MODEL:v1:${project_id}`;
  const promptLsKey = `AI-CODEX-ASSISTANT-PROMPT:v1:${project_id}:${path}:${type}`;
  const [model, setModelState] = useState<string>(() =>
    resolveAssistantCodexModel(
      LS.get(modelLsKey) ?? DEFAULT_ASSISTANT_CODEX_MODEL,
    ),
  );

  const canSubmit = useMemo(
    () => command.trim().length > 0 && !querying,
    [command, querying],
  );

  function setModel(next: string) {
    const resolved = resolveAssistantCodexModel(next);
    setModelState(resolved);
    LS.set(modelLsKey, resolved);
  }

  function closeDialog() {
    setShowDialog(false);
    setError("");
    actions.focus();
  }

  useEffect(() => {
    if (!showDialog) return;
    setError("");
    setCommand(LS.get(promptLsKey) ?? "");
    setModel(LS.get(modelLsKey) ?? DEFAULT_ASSISTANT_CODEX_MODEL);
    setTimeout(() => inputRef.current?.focus?.(), 10);
  }, [showDialog]);

  useEffect(() => {
    if (!command.trim()) {
      LS.del(promptLsKey);
      return;
    }
    LS.set(promptLsKey, command);
  }, [command, promptLsKey]);

  if (
    !actions.redux
      .getStore("projects")
      .hasLanguageModelEnabled(project_id, "assistant")
  ) {
    return null;
  }

  async function queryLLM(options: Options) {
    setError("");
    setQuerying(true);
    try {
      const input = actions.languageModelGetContext(id);
      await actions.languageModel(id, options, input);
      setCommand("");
      LS.del(promptLsKey);
    } catch (err) {
      setError(`${err}`);
      throw err;
    } finally {
      setQuerying(false);
    }
  }

  async function doIt() {
    if (!canSubmit || submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    try {
      closeDialog();
      await queryLLM({
        command: command.trim(),
        codegen: false,
        allowEmpty: true,
        model,
        tag: "custom",
      });
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <>
      <Button
        style={buttonStyle}
        size={buttonSize}
        onClick={() => {
          setError("");
          setShowDialog(!showDialog);
          actions.blur();
        }}
      >
        <span ref={buttonRef}>
          <AIAvatar
            size={16}
            iconColor={COLORS.AI_ASSISTANT_TXT}
            innerStyle={{ top: "2px" }}
          />
          {noLabel ? (
            ""
          ) : (
            <VisibleMDLG>
              <span style={{ marginLeft: "5px" }}>
                {intl.formatMessage(labels.assistant)}
              </span>
            </VisibleMDLG>
          )}
        </span>
      </Button>
      <Modal
        title={
          <Space align="center" size="small">
            <AIAvatar size={18} iconColor={COLORS.AI_ASSISTANT_TXT} />
            <span>{intl.formatMessage(labels.assistant)}</span>
          </Space>
        }
        open={Boolean(visible && showDialog)}
        onCancel={closeDialog}
        footer={null}
        destroyOnClose
        width={560}
        maskClosable={!querying}
      >
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Select
            value={model}
            onChange={setModel}
            style={{ width: "100%" }}
            popupMatchSelectWidth={false}
            options={DEFAULT_CODEX_MODELS.map((item) => ({
              value: item.name,
              label: item.description
                ? `${item.name} - ${item.description}`
                : item.name,
            }))}
          />
          <Input.TextArea
            ref={inputRef}
            value={command}
            disabled={querying}
            autoFocus
            allowClear
            placeholder="What should Codex do..."
            onChange={(e) => setCommand(e.target.value)}
            onPressEnter={(e) => {
              if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                void doIt();
              }
            }}
            autoSize={{ minRows: 3, maxRows: 8 }}
          />
          <div style={{ color: COLORS.GRAY_D }}>
            Codex will continue the work in the floating workspace agent thread.
          </div>
          {error ? <Alert type="error" title={error} /> : undefined}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={closeDialog} disabled={querying}>
              {intl.formatMessage(labels.cancel)}
            </Button>
            <Button
              type="primary"
              onClick={() => void doIt()}
              disabled={!canSubmit}
            >
              <Icon
                name={querying ? "spinner" : "paper-plane"}
                spin={querying}
              />{" "}
              Send to Codex
            </Button>
          </div>
        </Space>
      </Modal>
    </>
  );
}
