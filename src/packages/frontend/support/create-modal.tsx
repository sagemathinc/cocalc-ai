/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Input,
  Radio,
  Space,
  Typography,
} from "antd";
import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";
import ChatInput from "@cocalc/frontend/chat/input";
import { ThreadImageUpload } from "@cocalc/frontend/chat/thread-image-upload";
import api from "@cocalc/frontend/client/api";
import RecentFiles from "@cocalc/frontend/public/support/recent-files";
import { is_valid_email_address as isValidEmailAddress } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { openSupportTicketsPage } from "./open";
import type { Options as SupportOpenOptions } from "./url";

type TicketType = "problem" | "question" | "task" | "purchase" | "chat";

interface SupportFileRef {
  path?: string;
  project_id: string;
}

const { Paragraph, Text } = Typography;

const MIN_BODY_LENGTH = 16;

function normalizeType(value?: string): TicketType {
  switch (value) {
    case "problem":
    case "question":
    case "task":
    case "purchase":
    case "chat":
      return value;
    default:
      return "problem";
  }
}

function appendMarkdownImage(
  body: string,
  url: string,
  label = "Image",
): string {
  const trimmed = body.trimEnd();
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}![${label}](${url})\n`;
}

async function captureScreenshotBlob(): Promise<Blob> {
  const mediaDevices = navigator?.mediaDevices as MediaDevices | undefined;
  if (typeof mediaDevices?.getDisplayMedia !== "function") {
    throw Error("Screenshot capture is not supported by this browser.");
  }
  const stream = await mediaDevices.getDisplayMedia({
    video: true,
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await new Promise<void>((resolve) => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        resolve();
        return;
      }
      video.onloadeddata = () => resolve();
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context == null) {
      throw Error("Unable to capture screenshot.");
    }
    context.drawImage(video, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob == null) {
          reject(new Error("Unable to encode screenshot."));
          return;
        }
        resolve(blob);
      }, "image/png");
    });
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function submitButtonLabel(params: {
  email: string;
  body: string;
  subject: string;
  submitting: boolean;
  successUrl: string;
  submitError: string;
  type: TicketType;
  hasRequired: boolean;
}): string {
  const {
    body,
    email,
    hasRequired,
    subject,
    submitError,
    submitting,
    successUrl,
    type,
  } = params;
  if (submitting) return "Submitting...";
  if (successUrl) return "Ticket created";
  if (submitError) return "Fix the error above to try again";
  if (!isValidEmailAddress(email)) return "Enter a valid email address";
  if (!subject.trim()) return "Enter a subject";
  if (body.trim().length < MIN_BODY_LENGTH) {
    return type === "chat"
      ? "Describe the video chat you want"
      : `Describe your ${type} in more detail`;
  }
  if (!hasRequired) return "Replace the required placeholder text";
  return "Create support ticket";
}

export default function SupportCreateModal() {
  const pageActions = useActions("page");
  const accountEmail = useTypedRedux("account", "email_address") ?? "";
  const supportConfigured = !!useTypedRedux("customize", "zendesk");
  const initialOptions =
    useTypedRedux("page", "supportModalOptions") ?? ({} as SupportOpenOptions);

  const [body, setBody] = useState(initialOptions.body ?? "");
  const [email, setEmail] = useState(accountEmail);
  const [files, setFiles] = useState<SupportFileRef[]>([]);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [lastImageUrl, setLastImageUrl] = useState("");
  const [subject, setSubject] = useState(initialOptions.subject ?? "");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successUrl, setSuccessUrl] = useState("");
  const [type, setType] = useState<TicketType>(
    normalizeType(initialOptions.type),
  );

  useEffect(() => {
    setEmail(accountEmail);
  }, [accountEmail]);

  useEffect(() => {
    setBody(initialOptions.body ?? "");
    setFiles([]);
    setIncludeScreenshot(false);
    setLastImageUrl("");
    setSubject(initialOptions.subject ?? "");
    setSubmitError("");
    setSubmitting(false);
    setSuccessUrl("");
    setType(normalizeType(initialOptions.type));
  }, [
    initialOptions.body,
    initialOptions.subject,
    initialOptions.type,
    initialOptions.url,
    initialOptions.required,
  ]);

  const hasRequired =
    !initialOptions.required || !body.includes(initialOptions.required);
  const canSubmit =
    supportConfigured &&
    !submitting &&
    !successUrl &&
    isValidEmailAddress(email) &&
    subject.trim().length > 0 &&
    body.trim().length >= MIN_BODY_LENGTH &&
    hasRequired;

  const currentUrl = useMemo(() => {
    if (initialOptions.url?.trim()) {
      return initialOptions.url.trim();
    }
    return `${window.location.origin}${window.location.pathname}${window.location.search}`;
  }, [initialOptions.url]);

  async function attachScreenshot(input: string): Promise<string> {
    if (!includeScreenshot) {
      return input;
    }
    const screenshot = await captureScreenshotBlob();
    const { url } = await uploadBlobImage({
      file: screenshot,
      filename: `support-screenshot-${Date.now()}.png`,
    });
    return appendMarkdownImage(input, url, "Screenshot");
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const normalizedBody = await attachScreenshot(body);
      const result = await api("support/create-ticket", {
        options: {
          body: normalizedBody,
          email,
          files,
          info: {
            browser: navigator.userAgent,
            context: initialOptions.context,
            userAgent: navigator.userAgent,
          },
          subject,
          type,
          url: currentUrl,
        },
      });
      if (result?.error) {
        throw Error(result.error);
      }
      setSuccessUrl(result?.url ?? "");
    } catch (err) {
      setSubmitError(`${err}`);
    } finally {
      setSubmitting(false);
    }
  }

  const buttonText = submitButtonLabel({
    body,
    email,
    hasRequired,
    subject,
    submitError,
    submitting,
    successUrl,
    type,
  });

  if (!supportConfigured) {
    return (
      <Alert
        type="error"
        showIcon
        message="Support ticket creation is not configured."
      />
    );
  }

  if (successUrl) {
    return (
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="success"
          showIcon
          message="Successfully created support ticket"
          description={
            <a href={successUrl} target="_blank" rel="noreferrer noopener">
              {successUrl}
            </a>
          }
        />
        <Space wrap>
          <Button
            type="primary"
            onClick={() => {
              openSupportTicketsPage();
            }}
          >
            View my tickets
          </Button>
          <Button onClick={() => pageActions.settings("")}>Close</Button>
        </Space>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        message="Describe the issue, paste screenshots directly into the image box below, or attach one before submitting."
        description="The body uses the same markdown / rich-text composer as chat. Any images are converted to absolute links before the Zendesk ticket is created."
      />
      {initialOptions.required ? (
        <Alert
          type="warning"
          showIcon
          message="Replace the required placeholder text before submitting."
          description={`Update every '${initialOptions.required}' placeholder with the requested details.`}
        />
      ) : null}
      {submitError ? (
        <Alert
          type="error"
          showIcon
          message="Unable to create support ticket"
          description={submitError}
        />
      ) : null}
      <div>
        <Text strong>Email</Text>
        <Input
          disabled={submitting}
          placeholder="Email address..."
          style={{ marginTop: 8 }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <Text strong>Subject</Text>
        <Input
          disabled={submitting}
          placeholder="Summarize what this is about..."
          style={{ marginTop: 8 }}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <div>
        <Text strong>Type</Text>
        <div style={{ marginTop: 8 }}>
          <Radio.Group
            disabled={submitting}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <Space wrap>
              <Radio.Button value="problem">Problem</Radio.Button>
              <Radio.Button value="question">Question</Radio.Button>
              <Radio.Button value="task">Task</Radio.Button>
              <Radio.Button value="purchase">Purchase</Radio.Button>
              <Radio.Button value="chat">Video chat</Radio.Button>
            </Space>
          </Radio.Group>
        </div>
      </div>
      <div>
        <Text strong>Details</Text>
        <div
          style={{
            marginTop: 8,
            border: `1px solid ${COLORS.GRAY_LL}`,
            borderRadius: 12,
            padding: 8,
            background: "white",
          }}
        >
          <ChatInput
            key={`support-create-${currentUrl}`}
            autoGrowMaxHeight={320}
            enableMentions={false}
            enableUpload={false}
            fixedMode="editor"
            height="220px"
            input={body}
            isFocused
            on_send={() => undefined}
            onChange={(value) => setBody(value)}
            syncdb={undefined}
            date={-1}
            placeholder="Describe what happened, what you expected, and any steps we should follow to reproduce the issue."
          />
        </div>
      </div>
      <div>
        <Text strong>Images</Text>
        <Paragraph type="secondary" style={{ marginTop: 4 }}>
          Paste screenshots into the box below or upload them. Each image is
          inserted into the ticket body as markdown and converted to clickable
          absolute links for Zendesk.
        </Paragraph>
        <ThreadImageUpload
          modalTitle="Crop support image"
          uploadText="Click or drag an image, then crop if needed"
          value={lastImageUrl}
          onChange={(value) => {
            setLastImageUrl(value);
            setBody((current) => appendMarkdownImage(current, value));
          }}
        />
      </div>
      <Checkbox
        checked={includeScreenshot}
        disabled={submitting}
        onChange={(e) => setIncludeScreenshot(e.target.checked)}
      >
        Include a screenshot when I submit this ticket
      </Checkbox>
      <div>
        <Text strong>Relevant files</Text>
        <div style={{ marginTop: 8 }}>
          <RecentFiles disabled={submitting} onChange={setFiles} />
        </div>
      </div>
      <Divider style={{ margin: 0 }} />
      <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
        <Button onClick={() => openSupportTicketsPage()}>View tickets</Button>
        <Space wrap>
          <Button onClick={() => pageActions.settings("")}>Cancel</Button>
          <Button
            disabled={!canSubmit}
            loading={submitting}
            type="primary"
            onClick={() => void submit()}
          >
            {buttonText}
          </Button>
        </Space>
      </Space>
    </Space>
  );
}
