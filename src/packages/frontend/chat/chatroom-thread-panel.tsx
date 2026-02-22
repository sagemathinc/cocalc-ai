/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Select, Space } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { Icon } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { lite } from "@cocalc/frontend/lite";
import { COLORS } from "@cocalc/util/theme";
import {
  DEFAULT_CODEX_MODELS,
  resolveCodexSessionMode,
  type CodexReasoningId,
  type CodexSessionMode,
} from "@cocalc/util/ai/codex";
import type { CodexThreadConfig } from "@cocalc/chat";
import { ChatLog } from "./chat-log";
import CodexConfigButton from "./codex";
import { ThreadBadge } from "./thread-badge";
import type { ChatActions } from "./actions";
import type { ChatMessages } from "./types";
import type * as immutable from "immutable";
import type { ThreadIndexEntry } from "./message-cache";
import type { ThreadListItem, ThreadMeta } from "./threads";
import type { CodexPaymentSourceInfo } from "@cocalc/conat/hub/api/system";
import { THREAD_ICON_OPTIONS } from "./chatroom-modals";
import { ThreadImageUpload } from "./thread-image-upload";

const CHAT_LOG_STYLE: React.CSSProperties = {
  padding: "0",
  background: "white",
  flex: "1 1 0",
  minHeight: 0,
  position: "relative",
} as const;

const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODELS[0]?.name ?? "gpt-5.3-codex";
const DEFAULT_CODEX_SESSION_MODE: CodexSessionMode = lite
  ? "read-only"
  : "workspace-write";
const MODE_OPTIONS: { value: CodexSessionMode; label: string }[] = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "full-access", label: "Full access" },
];

export type NewThreadAgentMode = "codex" | "human" | "model";
export interface NewThreadSetup {
  title: string;
  icon?: string;
  color?: string;
  image?: string;
  agentMode: NewThreadAgentMode;
  model: string;
  codexConfig: Partial<CodexThreadConfig>;
}

export const DEFAULT_NEW_THREAD_SETUP: NewThreadSetup = {
  title: "",
  icon: undefined,
  color: undefined,
  image: "",
  agentMode: "codex",
  model: DEFAULT_CODEX_MODEL,
  codexConfig: {
    model: DEFAULT_CODEX_MODEL,
    sessionMode: DEFAULT_CODEX_SESSION_MODE,
    reasoning: getReasoningForModel({ modelValue: DEFAULT_CODEX_MODEL }),
  },
};

interface ChatRoomThreadPanelProps {
  actions: ChatActions;
  project_id?: string;
  path?: string;
  messages: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  acpState: immutable.Map<string, string>;
  scrollToBottomRef: React.MutableRefObject<any>;
  scrollCacheId: string;
  fontSize?: number;
  selectedThreadKey: string | null;
  selectedThread?: ThreadMeta | ThreadListItem;
  variant: "compact" | "default";
  scrollToIndex: number | null;
  scrollToDate: string | null;
  fragmentId: string | null;
  threadsCount: number;
  onNewChat: () => void;
  composerTargetKey?: string | null;
  composerFocused?: boolean;
  codexPaymentSource?: CodexPaymentSourceInfo;
  codexPaymentSourceLoading?: boolean;
  refreshCodexPaymentSource?: () => void;
  newThreadSetup: NewThreadSetup;
  onNewThreadSetupChange: (next: NewThreadSetup) => void;
}

export function ChatRoomThreadPanel({
  actions,
  project_id,
  path,
  messages,
  threadIndex,
  acpState,
  scrollToBottomRef,
  scrollCacheId,
  fontSize,
  selectedThreadKey,
  selectedThread,
  variant,
  scrollToIndex,
  scrollToDate,
  fragmentId,
  threadsCount,
  onNewChat,
  composerTargetKey,
  composerFocused,
  codexPaymentSource,
  codexPaymentSourceLoading,
  refreshCodexPaymentSource,
  newThreadSetup,
  onNewThreadSetupChange,
}: ChatRoomThreadPanelProps) {
  if (!selectedThreadKey) {
    const update = (patch: Partial<NewThreadSetup>) =>
      onNewThreadSetupChange({ ...newThreadSetup, ...patch });
    const iconOptions = THREAD_ICON_OPTIONS.map((icon) => ({
      value: icon,
      label: icon,
    }));
    const codexModel = newThreadSetup.codexConfig.model ?? DEFAULT_CODEX_MODEL;
    const codexReasoningOptions = (
      DEFAULT_CODEX_MODELS.find((model) => model.name === codexModel)?.reasoning ??
      []
    ).map((r) => ({
      value: r.id,
      label: r.label,
    }));
    return (
      <div
        className="smc-vfill"
        style={{
          ...CHAT_LOG_STYLE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: "min(840px, 96%)",
            margin: "0 auto",
            padding: "18px 20px",
            border: "1px solid #eee",
            borderRadius: 12,
            background: "#fcfcfc",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6 }}>New chat setup</div>
          <div style={{ color: "#666", marginBottom: 14, fontSize: 13 }}>
            All fields are optional and can be edited later from settings.
            Codex is selected by default.
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Title</div>
              <Input
                placeholder="Optional title"
                value={newThreadSetup.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                Chat type
              </div>
              <Select
                value={newThreadSetup.agentMode}
                style={{ width: "100%" }}
                onChange={(value) => {
                  const mode = value as NewThreadAgentMode;
                  if (mode === "codex") {
                    const model = isCodexModelName(newThreadSetup.model)
                      ? newThreadSetup.model
                      : DEFAULT_CODEX_MODEL;
                    update({
                      agentMode: mode,
                      model,
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        model,
                        sessionMode:
                          normalizeSessionMode(newThreadSetup.codexConfig) ??
                          DEFAULT_CODEX_SESSION_MODE,
                        reasoning: getReasoningForModel({
                          modelValue: model,
                          desired: newThreadSetup.codexConfig.reasoning,
                        }),
                      },
                    });
                    return;
                  }
                  update({ agentMode: mode });
                }}
                options={[
                  { value: "codex", label: "Codex (agent)" },
                  { value: "human", label: "Human only" },
                  { value: "model", label: "Other model" },
                ]}
              />
            </div>
            {newThreadSetup.agentMode !== "human" && (
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Default model
                </div>
                <Input
                  placeholder={
                    newThreadSetup.agentMode === "codex"
                      ? DEFAULT_CODEX_MODEL
                      : "e.g. gpt-4o"
                  }
                  value={newThreadSetup.model}
                  onChange={(e) => {
                    const model = e.target.value;
                    if (newThreadSetup.agentMode === "codex") {
                      update({
                        model,
                        codexConfig: {
                          ...newThreadSetup.codexConfig,
                          model,
                          reasoning: getReasoningForModel({
                            modelValue: model,
                            desired: newThreadSetup.codexConfig.reasoning,
                          }),
                        },
                      });
                    } else {
                      update({ model });
                    }
                  }}
                />
              </div>
            )}
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Icon</div>
              <Select
                allowClear
                showSearch
                value={newThreadSetup.icon}
                style={{ width: "100%" }}
                options={iconOptions}
                optionFilterProp="label"
                placeholder="Optional icon"
                onChange={(value) =>
                  update({ icon: value ? String(value) : undefined })
                }
                optionRender={(option) => (
                  <Space>
                    <Icon name={option.value as IconName} />
                    <span>{String(option.value)}</span>
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
                    background: newThreadSetup.color ?? COLORS.GRAY_L,
                    border: `1px solid ${COLORS.GRAY_L}`,
                  }}
                />
                <ColorButton
                  onChange={(value) => update({ color: value })}
                  title="Select chat color"
                />
                <Button
                  size="small"
                  onClick={() => update({ color: undefined })}
                >
                  Clear
                </Button>
              </Space>
            </div>
            <div>
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>Chat image</div>
              <Input
                style={{ width: "100%", marginBottom: 8 }}
                placeholder="Paste or drag image URL (optional)"
                value={newThreadSetup.image}
                onChange={(e) => update({ image: e.target.value })}
                onDrop={(e) => {
                  const uri =
                    e.dataTransfer.getData("text/uri-list") ||
                    e.dataTransfer.getData("text/plain");
                  if (uri?.trim()) {
                    e.preventDefault();
                    update({ image: uri.trim() });
                  }
                }}
              />
              <ThreadImageUpload
                projectId={project_id}
                value={newThreadSetup.image}
                onChange={(value) => update({ image: value })}
                modalTitle="Edit Chat Image"
                uploadText="Click or drag chat image"
                size={72}
              />
            </div>
          </div>
          {newThreadSetup.agentMode === "codex" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Codex model
                </div>
                <Select
                  value={codexModel}
                  style={{ width: "100%" }}
                  options={DEFAULT_CODEX_MODELS.map((model) => ({
                    value: model.name,
                    label: model.name,
                  }))}
                  showSearch
                  optionFilterProp="label"
                  onChange={(value) => {
                    const model = String(value);
                    update({
                      model,
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        model,
                        reasoning: getReasoningForModel({
                          modelValue: model,
                          desired: newThreadSetup.codexConfig.reasoning,
                        }),
                      },
                    });
                  }}
                />
              </div>
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Reasoning
                </div>
                <Select
                  allowClear
                  value={newThreadSetup.codexConfig.reasoning}
                  style={{ width: "100%" }}
                  options={codexReasoningOptions}
                  onChange={(value) =>
                    update({
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        reasoning: value as CodexReasoningId,
                      },
                    })
                  }
                />
              </div>
              <div>
                <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                  Execution mode
                </div>
                <Select
                  value={
                    normalizeSessionMode(newThreadSetup.codexConfig) ??
                    DEFAULT_CODEX_SESSION_MODE
                  }
                  style={{ width: "100%" }}
                  options={MODE_OPTIONS}
                  onChange={(value) =>
                    update({
                      codexConfig: {
                        ...newThreadSetup.codexConfig,
                        sessionMode: value as CodexSessionMode,
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {(newThreadSetup.icon || newThreadSetup.color) && (
                <ThreadBadge
                  icon={newThreadSetup.icon}
                  color={newThreadSetup.color}
                  image={newThreadSetup.image}
                  size={20}
                />
              )}
              <span style={{ color: "#666", fontSize: 13 }}>
                {threadsCount === 0
                  ? "No chats yet. Send your first message below."
                  : "Use these defaults for the next new chat you send."}
              </span>
            </div>
            <Button size="small" onClick={onNewChat}>
              Reset
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const shouldShowCodexConfig =
    selectedThread != null &&
    Boolean(selectedThread.rootMessage) &&
    Boolean(
      actions?.isCodexThread?.(new Date(parseInt(selectedThread.key, 10))),
    );
  const selectedThreadForLog = selectedThreadKey ?? undefined;
  const threadMeta =
    selectedThread && "displayLabel" in selectedThread
      ? selectedThread
      : undefined;
  const compactThreadLabel = threadMeta?.displayLabel ?? selectedThread?.label;
  const compactThreadIcon = threadMeta?.threadIcon;
  const compactThreadColor = threadMeta?.threadColor;
  const compactThreadImage = threadMeta?.threadImage;
  const compactThreadHasAppearance = threadMeta?.hasCustomAppearance ?? false;
  const threadImagePreview = compactThreadImage?.trim();

  return (
    <div
      className="smc-vfill"
      style={{
        ...CHAT_LOG_STYLE,
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {shouldShowCodexConfig && (
        <div style={{ position: "absolute", top: 8, left: 8, zIndex: 10 }}>
          <Space size={6}>
            <CodexConfigButton
              threadKey={selectedThreadKey}
              chatPath={path ?? ""}
              projectId={project_id}
              actions={actions}
              paymentSource={codexPaymentSource}
              paymentSourceLoading={codexPaymentSourceLoading}
              refreshPaymentSource={refreshCodexPaymentSource}
            />
          </Space>
        </div>
      )}
      {threadImagePreview ? (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 16,
            zIndex: 10,
            borderRadius: 10,
            overflow: "hidden",
            border: "1px solid #ddd",
            background: "white",
            boxShadow: "0 1px 8px rgba(0,0,0,0.12)",
          }}
        >
          <img
            src={threadImagePreview}
            alt="Chat image"
            style={{ width: 84, height: 84, objectFit: "cover", display: "block" }}
          />
        </div>
      ) : null}
      {variant === "compact" && compactThreadLabel && (
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "1px solid #e5e5e5",
            background: "#f7f7f7",
            color: "#555",
            fontWeight: 600,
            fontSize: "12px",
            letterSpacing: "0.02em",
            textTransform: "uppercase",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {compactThreadHasAppearance && (
            <ThreadBadge
              icon={compactThreadIcon}
              color={compactThreadColor}
              image={compactThreadImage}
              size={18}
            />
          )}
          {compactThreadLabel}
        </div>
      )}
      <ChatLog
        actions={actions}
        project_id={project_id ?? ""}
        path={path ?? ""}
        messages={messages}
        threadIndex={threadIndex}
        acpState={acpState}
        scrollToBottomRef={scrollToBottomRef}
        scrollCacheId={scrollCacheId}
        mode={variant === "compact" ? "sidechat" : "standalone"}
        fontSize={fontSize}
        selectedThread={selectedThreadForLog}
        scrollToIndex={scrollToIndex}
        scrollToDate={scrollToDate}
        selectedDate={fragmentId ?? undefined}
        composerTargetKey={composerTargetKey}
        composerFocused={composerFocused}
      />
    </div>
  );
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

function isCodexModelName(value?: string): boolean {
  if (!value) return false;
  return DEFAULT_CODEX_MODELS.some((model) => model.name === value);
}
