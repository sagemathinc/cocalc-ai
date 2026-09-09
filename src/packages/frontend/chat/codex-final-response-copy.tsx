/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import CopyButton from "@cocalc/frontend/components/copy-button";
import { Button, Modal, Space } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { startChatSpeech } from "./audio/chat-speech-player";

const READ_ALOUD_DISCLOSURE_KEY = "cocalc-chat-speech-output-disclosed";

export function CodexFinalResponseCopy({
  value,
  projectId,
  path,
  threadId,
  messageId = "codex-final-response",
}: {
  value: string;
  projectId?: string;
  path?: string;
  threadId?: string;
  messageId?: string;
}) {
  const start = () =>
    startChatSpeech({
      markdown: value,
      projectId,
      path,
      threadId,
      messageId,
      title: "Final response",
    });

  const requestReadAloud = () => {
    let disclosed = false;
    try {
      disclosed = localStorage.getItem(READ_ALOUD_DISCLOSURE_KEY) === "yes";
    } catch {
      // Storage can be unavailable in private or restricted browser contexts.
    }
    if (disclosed) {
      void start();
      return;
    }
    Modal.confirm({
      title: "Read this response aloud",
      content:
        "The response text is sent to the configured AI provider to create an artificial voice. CoCalc does not retain the generated audio.",
      okText: "Read aloud",
      cancelText: "Cancel",
      onOk: () => {
        try {
          localStorage.setItem(READ_ALOUD_DISCLOSURE_KEY, "yes");
        } catch {
          // The disclosure still applies to this playback.
        }
        return start();
      },
    });
  };

  return (
    <Space size={2}>
      <Tooltip title="Read final response aloud">
        <Button
          aria-label="Read final response aloud"
          icon={<Icon name="sound-outlined" />}
          onClick={requestReadAloud}
          size="small"
          type="text"
        />
      </Tooltip>
      <Tooltip title="Copy final response">
        <CopyButton
          markdown
          value={value}
          size="small"
          noText
          ariaLabel="Copy final response"
          style={{ color: UI_COLORS.muted, margin: -4 }}
        />
      </Tooltip>
    </Space>
  );
}
