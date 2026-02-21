/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Input, Select, Space } from "antd";
import { React } from "@cocalc/frontend/app-framework";
import { ColorButton } from "@cocalc/frontend/components/color-picker";
import { Icon } from "@cocalc/frontend/components";
import type { IconName } from "@cocalc/frontend/components/icon";
import { BlobUpload } from "@cocalc/frontend/file-upload";
import { COLORS } from "@cocalc/util/theme";
import { DEFAULT_CODEX_MODELS } from "@cocalc/util/ai/codex";
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

const CHAT_LOG_STYLE: React.CSSProperties = {
  padding: "0",
  background: "white",
  flex: "1 1 0",
  minHeight: 0,
  position: "relative",
} as const;

const DEFAULT_CODEX_MODEL = DEFAULT_CODEX_MODELS[0]?.name ?? "gpt-5.3-codex";

export type NewThreadAgentMode = "codex" | "human" | "model";
export interface NewThreadSetup {
  title: string;
  icon?: string;
  color?: string;
  image?: string;
  agentMode: NewThreadAgentMode;
  model: string;
}

export const DEFAULT_NEW_THREAD_SETUP: NewThreadSetup = {
  title: "",
  icon: undefined,
  color: undefined,
  image: "",
  agentMode: "codex",
  model: DEFAULT_CODEX_MODEL,
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
    const imageUploadClass = "chat-new-thread-image-upload";
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
          <div style={{ fontWeight: 600, marginBottom: 6 }}>New thread setup</div>
          <div style={{ color: "#666", marginBottom: 14, fontSize: 13 }}>
            All fields are optional and can be edited later from thread settings.
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
                Thread type
              </div>
              <Select
                value={newThreadSetup.agentMode}
                style={{ width: "100%" }}
                onChange={(value) =>
                  update({ agentMode: value as NewThreadAgentMode })
                }
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
                  onChange={(e) => update({ model: e.target.value })}
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
                  title="Select thread color"
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
              <div style={{ marginBottom: 4, color: COLORS.GRAY_D }}>
                Thread image URL
              </div>
              <Space style={{ width: "100%" }}>
                <Input
                  style={{ flex: 1 }}
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
                {project_id ? (
                  <BlobUpload
                    project_id={project_id}
                    show_upload={false}
                    config={{
                      clickable: `.${imageUploadClass}`,
                      acceptedFiles: "image/*",
                      maxFiles: 1,
                    }}
                    event_handlers={{
                      complete: (file) => {
                        if (file?.url) {
                          update({ image: file.url });
                        }
                      },
                    }}
                  >
                    <Button className={imageUploadClass}>Upload</Button>
                  </BlobUpload>
                ) : null}
              </Space>
            </div>
          </div>
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
                  : "Use these defaults for the next new thread you send."}
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
            right: 8,
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
            alt="Thread image"
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
