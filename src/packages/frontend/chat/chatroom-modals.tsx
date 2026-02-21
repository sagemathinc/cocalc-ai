/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Modal, Select, Space, message as antdMessage } from "antd";
import { useEffect, useMemo, useState } from "@cocalc/frontend/app-framework";
import { COLORS } from "@cocalc/util/theme";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { Icon } from "@cocalc/frontend/components";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import { BlobUpload } from "@cocalc/frontend/file-upload";
import type { IconName } from "@cocalc/frontend/components/icon";
import { capitalize } from "@cocalc/util/misc";
import type { CodexThreadConfig } from "@cocalc/chat";
import {
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
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
const MODE_OPTIONS: { value: CodexSessionMode; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];

export function ChatRoomModals({ actions, path, onHandlers }: ChatRoomModalsProps) {
  const { project_id } = useFrameContext();
  const [renamingThread, setRenamingThread] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [renameColor, setRenameColor] = useState<string | undefined>(undefined);
  const [renameIcon, setRenameIcon] = useState<IconName | undefined>(undefined);
  const [renameImage, setRenameImage] = useState<string>("");
  const [renameAgentMode, setRenameAgentMode] =
    useState<ThreadAgentMode>("codex");
  const [renameModel, setRenameModel] = useState<string>(DEFAULT_CODEX_MODEL);
  const [renameCodexConfig, setRenameCodexConfig] = useState<
    Partial<CodexThreadConfig>
  >({
    model: DEFAULT_CODEX_MODEL,
    sessionMode: "workspace-write",
    workingDirectory: defaultWorkingDir(path),
  });
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
  const renameImageUploadClass = useMemo(
    () => `thread-image-upload-${Math.random().toString(36).slice(2)}`,
    [],
  );

  const openRenameModal = (
    threadKey: string,
    currentLabel: string,
    _useCurrentLabel: boolean,
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
    setRenameValue(metadata?.name?.trim() || currentLabel || "");
    setRenameColor(
      metadata?.thread_color?.trim() || currentColor?.trim() || undefined,
    );
    setRenameIcon(
      (metadata?.thread_icon?.trim() as IconName) ||
        (currentIcon as IconName) ||
        undefined,
    );
    setRenameImage(metadata?.thread_image?.trim() || "");
    setRenameAgentMode(agentMode);
    setRenameModel(currentModel);
    const savedConfig = metadata?.acp_config ?? {};
    setRenameCodexConfig({
      ...savedConfig,
      model: currentModel,
      workingDirectory:
        savedConfig.workingDirectory?.trim() || defaultWorkingDir(path),
      sessionMode: resolveCodexSessionMode(savedConfig as CodexThreadConfig),
      reasoning: getReasoningForModel({
        modelValue: currentModel,
        desired: savedConfig.reasoning,
      }),
    });
  };

  const closeRenameModal = () => {
    setRenamingThread(null);
    setRenameValue("");
    setRenameColor(undefined);
    setRenameIcon(undefined);
    setRenameImage("");
    setRenameAgentMode("codex");
    setRenameModel(DEFAULT_CODEX_MODEL);
    setRenameCodexConfig({
      model: DEFAULT_CODEX_MODEL,
      sessionMode: "workspace-write",
      workingDirectory: defaultWorkingDir(path),
      reasoning: getReasoningForModel({ modelValue: DEFAULT_CODEX_MODEL }),
    });
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
      const model = renameCodexConfig.model?.trim() || DEFAULT_CODEX_MODEL;
      const sessionMode: CodexSessionMode = resolveCodexSessionMode(
        renameCodexConfig as CodexThreadConfig,
      );
      actions.setCodexConfig?.(renamingThread, {
        ...renameCodexConfig,
        model,
        reasoning: getReasoningForModel({
          modelValue: model,
          desired: renameCodexConfig.reasoning,
        }),
        sessionMode,
        allowWrite: sessionMode !== "read-only",
        workingDirectory:
          renameCodexConfig.workingDirectory?.trim() ||
          defaultWorkingDir(path),
        sessionId: renameCodexConfig.sessionId?.trim(),
        envHome: renameCodexConfig.envHome?.trim(),
        envPath: renameCodexConfig.envPath?.trim(),
      });
    } else {
      if (renameModel.trim()) {
        actions.setThreadModel?.(renamingThread, renameModel.trim() as any);
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
  const codexModelOptions = DEFAULT_CODEX_MODELS.map((model) => ({
    value: model.name,
    label: model.name,
  }));
  const reasoningOptions = (
    DEFAULT_CODEX_MODELS.find((model) => model.name === renameCodexConfig.model)
      ?.reasoning ?? []
  ).map((r) => ({
    value: r.id,
    label: r.label,
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
              style={{ width: "100%", marginBottom: 8 }}
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
            {project_id ? (
              <BlobUpload
                project_id={project_id}
                show_upload={false}
                config={{
                  clickable: `.${renameImageUploadClass}`,
                  acceptedFiles: "image/*",
                  maxFiles: 1,
                }}
                event_handlers={{
                  complete: (file) => {
                    if (file?.url) {
                      setRenameImage(file.url);
                    } else {
                      antdMessage.error("Image upload failed.");
                    }
                  },
                }}
              >
                <div
                  className={renameImageUploadClass}
                  style={{
                    border: "1px dashed #cfcfcf",
                    borderRadius: 8,
                    padding: "10px 12px",
                    color: "#666",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>
                    <Icon name="upload" /> Click or drag image here to upload
                  </span>
                  {renameImage ? (
                    <img
                      src={renameImage}
                      alt="Thread image preview"
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 6,
                        objectFit: "cover",
                        border: "1px solid #ddd",
                      }}
                    />
                  ) : null}
                </div>
              </BlobUpload>
            ) : null}
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
          {renameAgentMode === "codex" && (
            <div>
              <Space
                orientation="vertical"
                size={10}
                style={{ width: "100%" }}
              >
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Codex model
                  </div>
                  <Select
                    value={renameCodexConfig.model ?? DEFAULT_CODEX_MODEL}
                    style={{ width: "100%" }}
                    options={codexModelOptions}
                    showSearch
                    optionFilterProp="label"
                    onChange={(value) => {
                      const model = String(value);
                      setRenameModel(model);
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        model,
                        reasoning: getReasoningForModel({
                          modelValue: model,
                          desired: prev.reasoning,
                        }),
                      }));
                    }}
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Reasoning
                  </div>
                  <Select
                    allowClear
                    value={renameCodexConfig.reasoning}
                    style={{ width: "100%" }}
                    options={reasoningOptions}
                    onChange={(value) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        reasoning: value as CodexReasoningId,
                      }))
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Execution mode
                  </div>
                  <Select
                    value={resolveCodexSessionMode(
                      renameCodexConfig as CodexThreadConfig,
                    )}
                    style={{ width: "100%" }}
                    options={MODE_OPTIONS}
                    onChange={(value) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        sessionMode: value as CodexSessionMode,
                      }))
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Working directory
                  </div>
                  <Input
                    value={renameCodexConfig.workingDirectory ?? ""}
                    placeholder={defaultWorkingDir(path)}
                    onChange={(e) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        workingDirectory: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Session ID
                  </div>
                  <Input
                    value={renameCodexConfig.sessionId ?? ""}
                    placeholder="Optional"
                    onChange={(e) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        sessionId: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Environment HOME
                  </div>
                  <Input
                    value={renameCodexConfig.envHome ?? ""}
                    placeholder="Optional"
                    onChange={(e) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        envHome: e.target.value,
                      }))
                    }
                  />
                </div>
                <div>
                  <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                    Environment PATH
                  </div>
                  <Input
                    value={renameCodexConfig.envPath ?? ""}
                    placeholder="Optional"
                    onChange={(e) =>
                      setRenameCodexConfig((prev) => ({
                        ...prev,
                        envPath: e.target.value,
                      }))
                    }
                  />
                </div>
              </Space>
            </div>
          )}
          {renameAgentMode === "model" && (
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                Default model
              </div>
              <Input
                placeholder="e.g. gpt-4o"
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

function getReasoningForModel({
  modelValue,
  desired,
}: {
  modelValue?: string;
  desired?: CodexReasoningId;
}): CodexReasoningId | undefined {
  const model =
    DEFAULT_CODEX_MODELS.find((m) => m.name === modelValue) ??
    DEFAULT_CODEX_MODELS[0];
  const options = model?.reasoning ?? [];
  if (!options.length) return undefined;
  const match = options.find((r) => r.id === desired);
  return match?.id ?? options.find((r) => r.default)?.id ?? options[0]?.id;
}

function defaultWorkingDir(chatPath: string): string {
  if (!chatPath) return ".";
  const i = chatPath.lastIndexOf("/");
  if (i <= 0) return ".";
  return chatPath.slice(0, i);
}

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
