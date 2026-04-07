/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Checkbox,
  Input,
  Modal,
  Select,
  Space,
  message as antdMessage,
} from "antd";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "@cocalc/frontend/app-framework";
import { ThemeEditorModal } from "@cocalc/frontend/components";
import {
  defaultWorkingDirectoryForChat,
  useWorkspaceChatWorkingDirectory,
} from "@cocalc/frontend/project/workspaces/chat-defaults";
import { COLORS } from "@cocalc/util/theme";
import { HelpIcon } from "@cocalc/frontend/components/help-icon";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";
import type { IconName } from "@cocalc/frontend/components/icon";
import type { CodexThreadConfig } from "@cocalc/chat";
import { path_split } from "@cocalc/util/misc";
import {
  DEFAULT_CODEX_MODEL_NAME,
  DEFAULT_CODEX_MODELS,
  normalizeCodexSessionId,
  resolveCodexSessionMode,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import type { ChatActions } from "./actions";
import { getDefaultCodexSessionMode } from "./codex-defaults";
import { ThreadImageUpload } from "./thread-image-upload";
import type { ChatExportOpenRequest, ChatExportScope } from "./export-types";

export interface ChatRoomModalHandlers {
  openAppearanceModal: (
    threadKey: string,
    currentLabel: string,
    useCurrentLabel: boolean,
    currentColor?: string,
    currentIcon?: string,
  ) => void;
  openBehaviorModal: (threadKey: string) => void;
  openExportModal: (opts?: ChatExportOpenRequest) => void;
  openForkModal: (threadKey: string, label: string, isAI: boolean) => void;
}

interface ChatRoomModalsProps {
  actions: ChatActions;
  path: string;
  selectedThreadKey?: string | null;
  selectedThreadLabel?: string;
  isCombinedFeedSelected?: boolean;
  onHandlers?: (handlers: ChatRoomModalHandlers) => void;
}

type ThreadAgentMode = "codex" | "human";
const DEFAULT_CODEX_MODEL =
  DEFAULT_CODEX_MODELS[0]?.name ?? DEFAULT_CODEX_MODEL_NAME;
const MODE_OPTIONS: { value: CodexSessionMode; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];

type ExportRequest = {
  scope: ChatExportScope;
  threadKey?: string;
  label?: string;
};

export function ChatRoomModals({
  actions,
  path,
  selectedThreadKey,
  selectedThreadLabel,
  isCombinedFeedSelected = false,
  onHandlers,
}: ChatRoomModalsProps) {
  const defaultSessionMode = getDefaultCodexSessionMode();
  const { project_id } = useFrameContext();
  const workspaceWorkingDirectory = useWorkspaceChatWorkingDirectory(path);
  const [editingThread, setEditingThread] = useState<string | null>(null);
  const [appearanceOpen, setAppearanceOpen] = useState<boolean>(false);
  const [behaviorOpen, setBehaviorOpen] = useState<boolean>(false);
  const [renameValue, setRenameValue] = useState<string>("");
  const [renameColor, setRenameColor] = useState<string | undefined>(undefined);
  const [renameAccentColor, setRenameAccentColor] = useState<
    string | undefined
  >(undefined);
  const [renameIcon, setRenameIcon] = useState<IconName | undefined>(undefined);
  const [renameImage, setRenameImage] = useState<string>("");
  const [renameAgentMode, setRenameAgentMode] =
    useState<ThreadAgentMode>("codex");
  const [renameCodexConfig, setRenameCodexConfig] = useState<
    Partial<CodexThreadConfig>
  >({
    model: DEFAULT_CODEX_MODEL,
    sessionMode: defaultSessionMode,
    workingDirectory: defaultWorkingDir(path, workspaceWorkingDirectory),
  });
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const [exportScope, setExportScope] = useState<ChatExportScope>(
    "all-non-archived-threads",
  );
  const [exportFilename, setExportFilename] = useState<string>("");
  const [exportIncludeBlobs, setExportIncludeBlobs] = useState<boolean>(false);
  const [exportRunning, setExportRunning] = useState<boolean>(false);
  const [forkThread, setForkThread] = useState<{
    key: string;
    label: string;
    isAI: boolean;
  } | null>(null);
  const [forkName, setForkName] = useState<string>("");
  const [forkRunning, setForkRunning] = useState<boolean>(false);
  const loadThreadSettings = useCallback(
    (
      threadKey: string,
      currentLabel = "",
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
      }
      setEditingThread(threadKey);
      setRenameValue(metadata?.name?.trim() || currentLabel || "");
      setRenameColor(
        metadata?.thread_color?.trim() || currentColor?.trim() || undefined,
      );
      setRenameAccentColor(metadata?.thread_accent_color?.trim() || undefined);
      setRenameIcon(
        (metadata?.thread_icon?.trim() as IconName) ||
          (currentIcon as IconName) ||
          undefined,
      );
      setRenameImage(metadata?.thread_image?.trim() || "");
      setRenameAgentMode(agentMode);
      const savedConfig = metadata?.acp_config ?? {};
      setRenameCodexConfig({
        ...savedConfig,
        model: currentModel,
        workingDirectory:
          savedConfig.workingDirectory?.trim() ||
          defaultWorkingDir(path, workspaceWorkingDirectory),
        sessionMode:
          normalizeSessionMode(savedConfig as CodexThreadConfig) ??
          defaultSessionMode,
        reasoning: getReasoningForModel({
          modelValue: currentModel,
          desired: savedConfig.reasoning,
        }),
      });
    },
    [actions, path, defaultSessionMode, workspaceWorkingDirectory],
  );

  const openAppearanceModal = useCallback(
    (
      threadKey: string,
      currentLabel: string,
      _useCurrentLabel: boolean,
      currentColor?: string,
      currentIcon?: string,
    ) => {
      loadThreadSettings(threadKey, currentLabel, currentColor, currentIcon);
      setBehaviorOpen(false);
      setAppearanceOpen(true);
    },
    [loadThreadSettings],
  );

  const openBehaviorModal = useCallback(
    (threadKey: string) => {
      loadThreadSettings(threadKey);
      setAppearanceOpen(false);
      setBehaviorOpen(true);
    },
    [loadThreadSettings],
  );

  const closeEditingModals = () => {
    setEditingThread(null);
    setAppearanceOpen(false);
    setBehaviorOpen(false);
    setRenameValue("");
    setRenameColor(undefined);
    setRenameAccentColor(undefined);
    setRenameIcon(undefined);
    setRenameImage("");
    setRenameAgentMode("codex");
    setRenameCodexConfig({
      model: DEFAULT_CODEX_MODEL,
      sessionMode: defaultSessionMode,
      workingDirectory: defaultWorkingDir(path, workspaceWorkingDirectory),
      reasoning: getReasoningForModel({ modelValue: DEFAULT_CODEX_MODEL }),
    });
  };

  const handleAppearanceSave = () => {
    if (!editingThread) return;
    if (actions?.setThreadAppearance == null) {
      antdMessage.error("Chat appearance is not available.");
      return;
    }
    const success = actions.setThreadAppearance(editingThread, {
      name: renameValue.trim(),
      color: renameColor,
      accentColor: renameAccentColor,
      icon: renameIcon,
      image: renameImage.trim(),
    });
    if (!success) {
      antdMessage.error("Unable to save chat appearance.");
      return;
    }
    antdMessage.success("Appearance saved.");
    closeEditingModals();
  };

  const handleBehaviorSave = () => {
    if (!editingThread) return;
    if (renameAgentMode === "human") {
      actions.setThreadAgentMode?.(editingThread, "none");
    } else if (renameAgentMode === "codex") {
      const model = renameCodexConfig.model?.trim() || DEFAULT_CODEX_MODEL;
      const sessionMode: CodexSessionMode =
        normalizeSessionMode(renameCodexConfig) ?? defaultSessionMode;
      actions.setCodexConfig?.(editingThread, {
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
          defaultWorkingDir(path, workspaceWorkingDirectory),
        sessionId: normalizeCodexSessionId(renameCodexConfig.sessionId),
      });
    }
    antdMessage.success("Behavior saved.");
    closeEditingModals();
  };

  const openExportModal = useCallback(
    (opts?: ChatExportOpenRequest) => {
      const requestThreadKey =
        opts?.threadKey?.trim() ||
        (!isCombinedFeedSelected
          ? selectedThreadKey?.trim() || undefined
          : undefined);
      const requestLabel =
        opts?.label?.trim() ||
        (!isCombinedFeedSelected
          ? selectedThreadLabel?.trim() || undefined
          : undefined);
      const scope =
        opts?.scope ??
        (requestThreadKey ? "current-thread" : "all-non-archived-threads");
      setExportRequest({
        scope,
        threadKey: requestThreadKey,
        label: requestLabel,
      });
    },
    [isCombinedFeedSelected, selectedThreadKey, selectedThreadLabel],
  );

  const closeExportModal = () => {
    setExportRequest(null);
    setExportRunning(false);
  };

  const handleExportThread = async () => {
    if (!exportRequest) return;
    if (!actions?.exportChatArchive) {
      antdMessage.error("Export is not available.");
      return;
    }
    const outputPath = exportFilename.trim();
    if (!outputPath) {
      antdMessage.error("Please enter a filename.");
      return;
    }
    if (exportScope === "current-thread" && !exportRequest.threadKey) {
      antdMessage.error("Select a thread to export.");
      return;
    }
    try {
      setExportRunning(true);
      await actions.exportChatArchive({
        scope: exportScope,
        threadId:
          exportScope === "current-thread"
            ? exportRequest.threadKey
            : undefined,
        outputPath,
        includeBlobs: exportIncludeBlobs,
      });
      antdMessage.success("Chat exported.");
      closeExportModal();
    } catch (err) {
      console.error("failed to export chat", err);
      antdMessage.error(
        err instanceof Error && err.message
          ? err.message
          : "Failed to export chat.",
      );
    } finally {
      setExportRunning(false);
    }
  };

  const openForkModal = useCallback(
    (threadKey: string, label: string, isAI: boolean) => {
      setForkName(getDefaultForkName(label));
      setForkThread({ key: threadKey, label, isAI });
    },
    [],
  );

  const closeForkModal = () => {
    setForkRunning(false);
    setForkThread(null);
    setForkName("");
  };

  const handleForkThread = async () => {
    if (!forkThread || forkRunning) return;
    if (!actions?.forkThread) {
      antdMessage.error("Forking chats is not available.");
      return;
    }
    const title =
      forkName.trim() || `Fork of ${forkThread.label || "chat"}`.trim();
    try {
      setForkRunning(true);
      await actions.forkThread({
        threadKey: forkThread.key,
        title,
        sourceTitle: forkThread.label,
        isAI: forkThread.isAI,
        selectNewThread: false,
      });
      closeForkModal();
      antdMessage.success("Chat forked.");
    } catch (err) {
      console.error("failed to fork chat", err);
      antdMessage.error("Failed to fork chat.");
    } finally {
      setForkRunning(false);
    }
  };

  const handlers = useMemo(
    () => ({
      openAppearanceModal,
      openBehaviorModal,
      openExportModal,
      openForkModal,
    }),
    [openAppearanceModal, openBehaviorModal, openExportModal, openForkModal],
  );

  useEffect(() => {
    onHandlers?.(handlers);
  }, [handlers, onHandlers]);

  useEffect(() => {
    actions.openExportModal = openExportModal;
    return () => {
      if (actions.openExportModal === openExportModal) {
        actions.openExportModal = undefined;
      }
    };
  }, [actions, openExportModal]);

  useEffect(() => {
    if (!exportRequest) return;
    setExportScope(exportRequest.scope);
    setExportIncludeBlobs(false);
    setExportFilename(
      buildChatExportPath(path, exportRequest.scope, {
        threadKey: exportRequest.threadKey,
        label: exportRequest.label,
      }),
    );
  }, [exportRequest, path]);

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
          <span>
            {exportRequest?.label?.trim()
              ? `Export "${exportRequest.label.trim()}"`
              : "Export..."}{" "}
            <HelpIcon
              title="Chat export"
              maxWidth="34rem"
              style={{ marginLeft: 6 }}
            >
              <div style={{ display: "grid", gap: "0.5rem" }}>
                <div>
                  Export creates a self-contained archive bundle for the
                  selected chat scope. It includes archived/offloaded chat
                  messages and a human-readable transcript.
                </div>
                <div>
                  The archive also includes machine-readable JSON so agents can
                  inspect, transform, or re-use chat data outside the live chat
                  UI.
                </div>
                <div>
                  The export command runs on the local <code>.chat</code> file
                  and archived SQLite data where the command executes. It does
                  not copy the chat itself over the network first.
                </div>
                <div>
                  Use <code>Include blobs/assets</code> when you want embedded
                  images or uploaded files copied into the export.
                </div>
                <div>
                  The same export path is available from the CLI via{" "}
                  <code>cocalc export chat ...</code>, which is useful for
                  automation, testing, and agent workflows. Network access is
                  only needed when the export fetches blobs/assets.
                </div>
              </div>
            </HelpIcon>
          </span>
        }
        open={exportRequest != null}
        onCancel={closeExportModal}
        onOk={handleExportThread}
        okText="Export"
        okButtonProps={{ loading: exportRunning }}
        destroyOnHidden
      >
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Scope</div>
            <Select
              value={exportScope}
              style={{ width: "100%" }}
              onChange={(value) => {
                const scope = value as ChatExportScope;
                setExportScope(scope);
                setExportFilename(
                  buildChatExportPath(path, scope, {
                    threadKey: exportRequest?.threadKey,
                    label: exportRequest?.label,
                  }),
                );
              }}
              options={[
                {
                  value: "current-thread",
                  label: exportRequest?.label?.trim()
                    ? `This thread (${exportRequest.label.trim()})`
                    : "This thread",
                  disabled: !exportRequest?.threadKey,
                },
                {
                  value: "all-non-archived-threads",
                  label: "All non-archived threads",
                },
                {
                  value: "all-threads",
                  label: "All threads",
                },
              ]}
            />
          </div>
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
          <Checkbox
            checked={exportIncludeBlobs}
            onChange={(e) => setExportIncludeBlobs(e.target.checked)}
          >
            Include blobs/assets
          </Checkbox>
          <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
            Export includes archived/offloaded chat messages for the selected
            threads. Codex activity logs are excluded.
          </div>
        </Space>
      </Modal>
      <ThemeEditorModal
        open={appearanceOpen}
        title="Edit Thread Appearance"
        value={{
          title: renameValue,
          description: "",
          color: renameColor ?? null,
          accent_color: renameAccentColor ?? null,
          icon: renameIcon ?? "",
          image_blob: renameImage,
        }}
        onChange={(patch) => {
          if (patch.title != null) setRenameValue(patch.title);
          if (patch.color !== undefined) {
            setRenameColor(patch.color ?? undefined);
          }
          if (patch.accent_color !== undefined) {
            setRenameAccentColor(patch.accent_color ?? undefined);
          }
          if (patch.icon != null) {
            setRenameIcon(patch.icon ? (patch.icon as IconName) : undefined);
          }
          if (patch.image_blob != null) {
            setRenameImage(patch.image_blob);
          }
        }}
        onCancel={closeEditingModals}
        onSave={handleAppearanceSave}
        defaultIcon="comment"
        showDescription={false}
        previewImageUrl={renameImage}
        extraBeforeTheme={
          <span style={{ color: COLORS.GRAY_D }}>
            Customize this thread appearance.
          </span>
        }
        renderImageInput={() => (
          <ThreadImageUpload
            projectId={project_id}
            value={renameImage}
            onChange={setRenameImage}
            modalTitle="Edit Chat Image"
            uploadText="Click or drag chat image"
            size={64}
          />
        )}
      />
      <Modal
        title="Edit Thread Behavior"
        open={behaviorOpen}
        onCancel={closeEditingModals}
        onOk={handleBehaviorSave}
        destroyOnHidden
      >
        <Space orientation="vertical" size={12} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              Chat behavior
            </div>
            <Select
              value={renameAgentMode}
              style={{ width: "100%" }}
              onChange={(value) => setRenameAgentMode(value as ThreadAgentMode)}
              options={[
                { value: "codex", label: "Codex (agent)" },
                { value: "human", label: "Human only" },
              ]}
            />
          </div>
          {renameAgentMode === "codex" ? (
            <Space orientation="vertical" size={10} style={{ width: "100%" }}>
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
                  value={
                    normalizeSessionMode(renameCodexConfig) ??
                    defaultSessionMode
                  }
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
                  placeholder={defaultWorkingDir(
                    path,
                    workspaceWorkingDirectory,
                  )}
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
            </Space>
          ) : null}
          <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
            All behavior settings here can be changed later.
          </div>
        </Space>
      </Modal>
      <Modal
        title="Fork chat"
        open={forkThread != null}
        onCancel={closeForkModal}
        onOk={handleForkThread}
        okText="Fork"
        okButtonProps={{ loading: forkRunning, disabled: forkRunning }}
        cancelButtonProps={{ disabled: forkRunning }}
        destroyOnHidden
      >
        <Space orientation="vertical" size={10} style={{ width: "100%" }}>
          <div>
            <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
              New chat name
            </div>
            <Input
              disabled={forkRunning}
              value={forkName}
              onChange={(e) => setForkName(e.target.value)}
              onPressEnter={handleForkThread}
            />
          </div>
          <div style={{ color: COLORS.GRAY_D, fontSize: 12 }}>
            This creates a new chat and links it to the current one. For Codex
            chats, the agent session will be forked with the same context.
          </div>
        </Space>
      </Modal>
    </>
  );
}

export function getDefaultForkName(label?: string): string {
  return label?.trim() ? `Fork of ${label.trim()}` : "Fork of chat";
}

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

function normalizeSessionMode(
  config?: Partial<CodexThreadConfig>,
): CodexSessionMode | undefined {
  const mode = resolveCodexSessionMode(config as CodexThreadConfig);
  if (
    mode === "read-only" ||
    mode === "workspace-write" ||
    mode === "full-access"
  ) {
    return mode;
  }
  return undefined;
}

function defaultWorkingDir(
  chatPath: string,
  workspaceWorkingDirectory?: string,
): string {
  return defaultWorkingDirectoryForChat(chatPath, workspaceWorkingDirectory);
}

function buildChatExportPath(
  chatPath: string | undefined,
  scope: ChatExportScope,
  opts: {
    threadKey?: string;
    label?: string;
  } = {},
): string {
  const normalizedPath = `${chatPath ?? "chat"}`.trim() || "chat";
  const { head, tail } = path_split(normalizedPath);
  const stem = tail.endsWith(".chat") ? tail.slice(0, -".chat".length) : tail;
  const scopeSuffix =
    scope === "current-thread"
      ? `.${slugifyLabel(opts.label) || opts.threadKey || "thread"}`
      : scope === "all-threads"
        ? ".all-threads"
        : ".threads";
  return `${head ? `${head}/` : ""}${stem || "chat"}${scopeSuffix}.cocalc-export.zip`;
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
