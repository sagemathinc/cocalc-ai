/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert, Button, Modal, Space } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import { CSS } from "@cocalc/frontend/app-framework";
import { Icon, VisibleMDLG } from "@cocalc/frontend/components";
import AIAvatar from "@cocalc/frontend/components/ai-avatar";
import { labels } from "@cocalc/frontend/i18n";
import * as LS from "@cocalc/frontend/misc/local-storage-typed";
import { COLORS } from "@cocalc/util/theme";
import { BaseEditorActions as Actions } from "../base-editor/actions-base";
import { DEFAULT_ASSISTANT_CODEX_MODEL, Options } from "./create-chat";
import { PopupAgentComposer } from "./popup-agent-composer";

const TITLE_BAR_AGENT_LABEL = "Agent";

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
  const submittingRef = useRef(false);
  const [error, setError] = useState<string>("");
  const [querying, setQuerying] = useState<boolean>(false);
  const [command, setCommand] = useState<string>("");

  const promptLsKey = `AI-CODEX-ASSISTANT-PROMPT:v1:${project_id}:${path}:${type}`;

  const canSubmit = useMemo(
    () => command.trim().length > 0 && !querying,
    [command, querying],
  );

  function closeDialog() {
    setShowDialog(false);
    setError("");
    actions.focus();
  }

  useEffect(() => {
    if (!showDialog) return;
    setError("");
    setCommand(LS.get(promptLsKey) ?? "");
  }, [showDialog, promptLsKey]);

  useEffect(() => {
    if (!command.trim()) {
      LS.del(promptLsKey);
      return;
    }
    LS.set(promptLsKey, command);
  }, [command, promptLsKey]);

  const normalizedPath = `${path ?? ""}`.trim().toLowerCase();
  if (type === "chat" || normalizedPath.endsWith(".chat")) {
    return null;
  }

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

  async function doIt(nextCommand?: string) {
    const resolvedCommand = `${nextCommand ?? command}`.trim();
    if (!resolvedCommand || querying || submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    try {
      closeDialog();
      await queryLLM({
        command: resolvedCommand,
        codegen: false,
        allowEmpty: true,
        model: DEFAULT_ASSISTANT_CODEX_MODEL,
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
            iconColor="currentColor"
            innerStyle={{ top: "2px" }}
          />
          {noLabel ? (
            ""
          ) : (
            <VisibleMDLG>
              <span style={{ marginLeft: "5px" }}>{TITLE_BAR_AGENT_LABEL}</span>
            </VisibleMDLG>
          )}
        </span>
      </Button>
      <Modal
        title={
          <Space align="center" size="small">
            <AIAvatar size={18} iconColor="currentColor" />
            <span>{TITLE_BAR_AGENT_LABEL}</span>
          </Space>
        }
        open={Boolean(visible && showDialog)}
        onCancel={closeDialog}
        footer={null}
        destroyOnClose
        width={560}
        maskClosable={!querying}
      >
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          <PopupAgentComposer
            value={command}
            onChange={setCommand}
            onSubmit={(value) => void doIt(value)}
            placeholder="What should the agent do..."
            cacheId={`popup-agent:${project_id}:${path}:${type}`}
            autoFocus
          />
          <div style={{ color: COLORS.GRAY_D }}>
            The agent will continue the work in the workspace agent thread.
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
              Send to Agent
            </Button>
          </div>
        </Space>
      </Modal>
    </>
  );
}
