/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Modal, Select, Space, message as antdMessage } from "antd";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { Icon } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { capitalize } from "@cocalc/util/misc";
import { DEFAULT_CODEX_MODELS } from "@cocalc/util/ai/codex";
import type { ChatActions } from "./actions";

export interface ChatRoomModalHandlers {
  openRenameModal: (
    threadKey: string,
    currentLabel: string,
    useCurrentLabel: boolean,
    currentColor?: string,
    currentIcon?: string,
  ) => void;
  openExportModal: (threadKey: string, label: string, isAI: boolean) => void;
  openForkModal: (threadKey: string, label: string, isAI: boolean) => void;
}

interface ChatRoomModalsProps {
  actions: ChatActions;
  path: string;
  onHandlers?: (handlers: ChatRoomModalHandlers) => void;
}

type ThreadAgentMode = "codex" | "human" | "model";
const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODELS[0]?.name ?? "gpt-5.3-codex";

export function ChatRoomModals({ actions, path, onHandlers }: ChatRoomModalsProps) {
  const [renamingThread, setRenamingThread] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [renameColor, setRenameColor] = useState<string | undefined>(undefined);
  const [renameIcon, setRenameIcon] = useState<IconName | undefined>(undefined);
  const [renameImage, setRenameImage] = useState<string>("");
  const [renameAgentMode, setRenameAgentMode] =
    useState<ThreadAgentMode>("codex");
  const [renameModel, setRenameModel] = useState<string>(DEFAULT_CODEX_MODEL);
  const [exportThread, setExportThread] = useState<{
    key: string;
    label: string;
    isAI: boolean;
  } | null>(null);
  const [exportFilename, setExportFilename] = useState<string>("");
  const [forkThread, setForkThread] = useState<{
    key: string;
    label: string;
    isAI: boolean;
  } | null>(null);
  const [forkName, setForkName] = useState<string>("");

  const openRenameModal = (
    threadKey: string,
    currentLabel: string,
    useCurrentLabel: boolean,
    currentColor?: string,
    currentIcon?: string,
  ) => {
    const metadata = actions?.getThreadMetadata?.(threadKey);
    const currentModel =
      metadata?.agent_model?.trim() ||
      metadata?.acp_config?.model?.trim() ||
      DEFAULT_CODEX_MODEL;
    let agentMode: ThreadAgentMode = "human";
    if (metadata?.agent_kind === "acp" || metadata?.acp_config != null) {
      agentMode = "codex";
    } else if (metadata?.agent_kind === "llm") {
      agentMode = "model";
    }
    setRenamingThread(threadKey);
    setRenameValue(useCurrentLabel ? currentLabel : "");
    setRenameColor(currentColor?.trim() || undefined);
    setRenameIcon((currentIcon as IconName) || undefined);
    setRenameImage(metadata?.thread_image?.trim() || "");
    setRenameAgentMode(agentMode);
    setRenameModel(currentModel);
  };

  const closeRenameModal = () => {
    setRenamingThread(null);
    setRenameValue("");
    setRenameColor(undefined);
    setRenameIcon(undefined);
    setRenameImage("");
    setRenameAgentMode("codex");
    setRenameModel(DEFAULT_CODEX_MODEL);
  };

  const handleRenameSave = () => {
    if (!renamingThread) return;
    if (actions?.setThreadAppearance == null) {
      antdMessage.error("Thread settings are not available.");
      return;
    }
    const success = actions.setThreadAppearance(renamingThread, {
      name: renameValue.trim(),
      color: renameColor,
      icon: renameIcon,
      image: renameImage.trim(),
    });
    if (!success) {
      antdMessage.error("Unable to save thread settings.");
      return;
    }
    if (renameAgentMode === "human") {
      actions.setThreadAgentMode?.(renamingThread, "none");
    } else if (renameAgentMode === "codex") {
      actions.setThreadAgentMode?.(renamingThread, "codex", {
        model: renameModel.trim() || DEFAULT_CODEX_MODEL,
      });
    } else {
      const threadMs = parseInt(renamingThread, 10);
      if (Number.isFinite(threadMs) && renameModel.trim()) {
        actions.recordThreadAgentModel?.(new Date(threadMs), renameModel.trim() as any);
      } else {
        actions.setThreadAgentMode?.(renamingThread, "none");
      }
    }
    antdMessage.success("Thread settings saved.");
    closeRenameModal();
  };

  const openExportModal = (threadKey: string, label: string, isAI: boolean) => {
    setExportThread({ key: threadKey, label, isAI });
  };

  const closeExportModal = () => {
    setExportThread(null);
  };

  const handleExportThread = async () => {
    if (!exportThread) return;
    if (!actions?.exportThreadToMarkdown) {
      antdMessage.error("Export is not available.");
      return;
    }
    const outputPath = exportFilename.trim();
    if (!outputPath) {
      antdMessage.error("Please enter a filename.");
      return;
    }
    try {
      await actions.exportThreadToMarkdown({
        threadKey: exportThread.key,
        path: outputPath,
      });
      antdMessage.success("Chat exported.");
      closeExportModal();
    } catch (err) {
      console.error("failed to export chat", err);
      antdMessage.error("Failed to export chat.");
    }
  };

  const openForkModal = (threadKey: string, label: string, isAI: boolean) => {
    setForkThread({ key: threadKey, label, isAI });
  };

  const closeForkModal = () => {
    setForkThread(null);
    setForkName("");
  };

  const handleForkThread = async () => {
    if (!forkThread) return;
    if (!actions?.forkThread) {
      antdMessage.error("Forking chats is not available.");
      return;
    }
    const title =
      forkName.trim() || `Fork of ${forkThread.label || "chat"}`.trim();
    try {
      await actions.forkThread({
        threadKey: forkThread.key,
        title,
        sourceTitle: forkThread.label,
        isAI: forkThread.isAI,
      });
      antdMessage.success("Chat forked.");
      closeForkModal();
    } catch (err) {
      console.error("failed to fork chat", err);
      antdMessage.error("Failed to fork chat.");
    }
  };

  const handlers = useMemo(
    () => ({ openRenameModal, openExportModal, openForkModal }),
    [],
  );

  useEffect(() => {
    onHandlers?.(handlers);
  }, [handlers, onHandlers]);

  useEffect(() => {
    if (!exportThread) return;
    const defaultPath = buildThreadExportPath(
      path,
      exportThread.key,
      exportThread.label,
    );
    setExportFilename(defaultPath);
  }, [exportThread, path]);

  useEffect(() => {
    if (!forkThread) return;
    const name = forkThread.label?.trim()
      ? `Fork of ${forkThread.label.trim()}`
      : "Fork of chat";
    setForkName(name);
  }, [forkThread]);

  const iconOptions = THREAD_ICON_OPTIONS.map((icon) => ({
    value: icon,
    label: icon,
  }));

  return (
    <>
      <Modal
        title={
          exportThread?.label?.trim()
            ? `Export "${exportThread.label.trim()}"`
            : "Export chat"
        }
        open={exportThread != null}
        onCancel={closeExportModal}
        onOk={handleExportThread}
        okText="Export"
        destroyOnHidden
      >
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              Filename
            </div>
            <Input
              value={exportFilename}
              onChange={(e) => setExportFilename(e.target.value)}
              onPressEnter={handleExportThread}
            />
          </div>
        </Space>
      </Modal>
      <Modal
        title="Thread settings"
        open={renamingThread != null}
        onCancel={closeRenameModal}
        onOk={handleRenameSave}
        okText="Save"
        destroyOnHidden
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              Chat name
            </div>
            <Input
              placeholder="Chat name"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onPressEnter={handleRenameSave}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Icon</div>
            <Select
              allowClear
              showSearch
              value={renameIcon}
              style={{ width: "100%" }}
              options={iconOptions}
              optionFilterProp="label"
              placeholder="Select an icon"
              onChange={(value) =>
                setRenameIcon(value ? (value as IconName) : undefined)
              }
              optionRender={(option) => (
                <Space>
                  <Icon name={option.value as IconName} />
                  <span>{capitalize(String(option.value))}</span>
                </Space>
              )}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Color</div>
            <Space>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: renameColor ?? COLORS.GRAY_L,
                  border: `1px solid ${COLORS.GRAY_L}`,
                }}
              />
              <ColorButton
                onChange={(value) => setRenameColor(value)}
                title="Select thread color"
              />
              <Button size="small" onClick={() => setRenameColor(undefined)}>
                Clear
              </Button>
            </Space>
          </div>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              Thread image URL
            </div>
            <Input
              placeholder="Paste or drag an image URL (optional)"
              value={renameImage}
              onChange={(e) => setRenameImage(e.target.value)}
              onDrop={(e) => {
                const uri =
                  e.dataTransfer.getData("text/uri-list") ||
                  e.dataTransfer.getData("text/plain");
                if (uri?.trim()) {
                  e.preventDefault();
                  setRenameImage(uri.trim());
                }
              }}
            />
          </div>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              Thread behavior
            </div>
            <Select
              value={renameAgentMode}
              style={{ width: "100%" }}
              onChange={(value) => setRenameAgentMode(value as ThreadAgentMode)}
              options={[
                { value: "codex", label: "Codex (agent)" },
                { value: "human", label: "Human only" },
                { value: "model", label: "Other model" },
              ]}
            />
          </div>
          {renameAgentMode !== "human" && (
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                Default model
              </div>
              <Input
                placeholder={
                  renameAgentMode === "codex"
                    ? DEFAULT_CODEX_MODEL
                    : "e.g. gpt-4o"
                }
                value={renameModel}
                onChange={(e) => setRenameModel(e.target.value)}
              />
            </div>
          )}
          <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
            All settings here can be changed later.
          </div>
        </Space>
      </Modal>
      <Modal
        title="Fork chat"
        open={forkThread != null}
        onCancel={closeForkModal}
        onOk={handleForkThread}
        okText="Fork"
        destroyOnHidden
      >
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              New chat name
            </div>
            <Input
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
              onPressEnter={handleForkThread}
            />
          </div>
          <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
            This creates a new thread and links it to the current one. For
            Codex threads, the agent session will be forked with the same
            context.
          </div>
        </Space>
      </Modal>
    </>
  );
}

export const THREAD_ICON_OPTIONS: IconName[] = [
  "thumbs-up",
  "thumbs-down",
  "question-circle",
  "heart",
  "star",
  "plus-one",
  "jupyter",
  "smile",
  "frown",
  "fire",
  "sagemath",
  "tex",
  "bolt",
  "graduation-cap",
  "python",
  "r",
  "calculator",
  "cocalc-ring",
  "hand",
  "exchange",
  "exclamation-triangle",
  "user",
  "cube",
  "dot-circle",
];

function buildThreadExportPath(
  chatPath: string | undefined,
  threadKey: string,
  label?: string,
): string {
  const base = (chatPath || "chat").replace(/\/+$/, "");
  const slug = slugifyLabel(label);
  const suffix = slug || threadKey || "thread";
  return `${base}.${suffix}.md`;
}

function slugifyLabel(label?: string): string {
  if (!label) return "";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug;
}
