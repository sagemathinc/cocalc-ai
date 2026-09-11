import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, Button, Space } from "antd";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import MarkdownInput from "@cocalc/frontend/editors/markdown-input/multimode";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { uploadBlobImage } from "@cocalc/frontend/blobs/upload-image";
import { useChatComposerDraft } from "./use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "./utils";
import { contextualReplyMessage } from "./contextual-reply-context";
import type { ReplyContext } from "./contextual-reply-context";
import type { ChatActions } from "./actions";
import { waitForCommentAcceptance } from "./comment-send-status";
import {
  getPendingChatBrowserSessionId,
  storePendingChatSend,
  removePendingChatSend,
} from "./pending-chat-outbox";

interface CommentDraft {
  context: ReplyContext;
  text: string;
  identity?: ReturnType<ChatActions["reserveChatSendIdentity"]>;
  submitted?: boolean;
}

export default function ContextualReplyEditor({
  actions,
  projectId,
  path,
  context,
  rect,
  image,
  onClose,
}: {
  actions: ChatActions;
  projectId: string;
  path: string;
  context: ReplyContext;
  rect: DOMRect;
  image?: Blob;
  onClose: () => void;
}) {
  const account_id = useTypedRedux("account", "account_id");
  const destination =
    actions.getThreadMetadata?.(context.source.thread_id)?.name ||
    context.source.thread_id.slice(0, 8);
  const draft = useChatComposerDraft({
    account_id,
    project_id: projectId,
    path,
    composerDraftKey: stableDraftKeyFromThreadKey(context.source.thread_id),
    suffix: `local-comment:${account_id}:${context.source.kind}:${context.source.id}`,
  });
  const [value, setValue] = useState<CommentDraft>();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const acceptance = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => acceptance.current?.abort(), []);
  const panel = useRef<HTMLDivElement>(null);
  const getValue = useRef<() => string>(() => value?.text ?? "");
  useEffect(() => {
    if (!draft.ready || value) return;
    try {
      const saved = draft.input
        ? (JSON.parse(draft.input) as CommentDraft)
        : undefined;
      if (
        saved &&
        (saved.context.source.id !== context.source.id ||
          saved.context.source.thread_id !== context.source.thread_id ||
          typeof saved.text !== "string" ||
          (saved.identity &&
            (!saved.identity.message_id ||
              saved.identity.thread_id !== context.source.thread_id)))
      )
        throw Error("Cannot restore this comment draft.");
      setValue(
        saved ?? {
          context,
          text: "",
        },
      );
    } catch (err) {
      setError(String(err));
    }
  }, [draft.ready, draft.input, value, context, actions]);
  useEffect(() => {
    if (value)
      panel.current
        ?.querySelector<HTMLElement>('[contenteditable="true"], textarea')
        ?.focus({ preventScroll: true });
  }, [!!value]);
  function update(text: string) {
    if (!value || value.submitted) return;
    const next = { ...value, text };
    setValue(next);
    draft.setInput(JSON.stringify(next));
  }
  function close() {
    if (sendingRef.current) return;
    if (value) update(getValue.current());
    onClose();
  }
  async function send() {
    if (!value || sendingRef.current) return;
    const text = getValue.current().trim();
    if (!text) return;
    sendingRef.current = true;
    setSending(true);
    setError("");
    try {
      if (new TextEncoder().encode(text).length > 32 * 1024)
        throw Error(
          "Comment exceeds 32 KiB. Please shorten it; your draft is retained.",
        );
      const identity =
        value.identity ??
        actions.reserveChatSendIdentity({
          reply_thread_id: value.context.source.thread_id,
        });
      const controller = new AbortController();
      acceptance.current = controller;
      const existing = actions.getMessageById?.(identity.message_id);
      if (existing || value.submitted) {
        await waitForCommentAcceptance(
          actions,
          identity.message_id,
          controller.signal,
        );
        await draft.clearInput();
        onClose();
        return;
      }
      let captured = value.context;
      if (captured.image && !captured.image.url) {
        if (!image || captured.image.sha256 !== context.image?.sha256)
          throw Error(
            "The image changed since this draft was saved. Your comment is retained. Close and discard the old draft before commenting on the new image.",
          );
        const uploaded = await uploadBlobImage({
          file: image,
          projectId,
          filename: `comment-image.${image.type === "image/jpeg" ? "jpg" : image.type === "image/webp" ? "webp" : image.type === "image/gif" ? "gif" : "png"}`,
        });
        captured = {
          ...captured,
          image: { ...captured.image, url: uploaded.url },
        };
      }
      const next = { ...value, text, context: captured, identity };
      setValue(next);
      draft.setInput(JSON.stringify(next));
      const pending = {
        ...contextualReplyMessage(text, captured),
        project_id: projectId,
        path,
        account_id,
        sender_id: account_id,
        shouldMarkNotSent: true,
        browser_session_id: getPendingChatBrowserSessionId(),
        ...identity,
        reply_thread_id: captured.source.thread_id,
        acpConfigOverride:
          actions.getCodexConfig?.(captured.source.thread_id) ?? undefined,
      };
      const stored = await storePendingChatSend(pending);
      if (!stored)
        throw Error(
          "Durable message storage is unavailable. Your draft has been kept; retry when connected.",
        );
      const submitted = { ...next, submitted: true };
      setValue(submitted);
      draft.setInput(JSON.stringify(submitted));
      const sent = actions.sendChat({
        ...pending,
        chatIdentity: identity,
        preserveSelectedThread: true,
        skipDraftDelete: true,
      });
      if (!sent) {
        await removePendingChatSend(pending);
        setValue(next);
        draft.setInput(JSON.stringify(next));
        throw Error("The chat is not ready. Your comment has been kept.");
      }
      await waitForCommentAcceptance(
        actions,
        identity.message_id,
        controller.signal,
      );
      await draft.clearInput();
      onClose();
    } catch (err) {
      if (!acceptance.current?.signal.aborted) setError(String(err));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }
  return createPortal(
    <KeyboardBoundary
      role="dialog"
      aria-label="Comment on selection"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !sending) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
      style={{
        position: "fixed",
        boxSizing: "border-box",
        zIndex: 1200,
        width: "min(420px, calc(100vw - 24px))",
        maxHeight: "calc(100vh - 24px)",
        overflow: "auto",
        left: `max(12px, min(${rect.left}px, calc(100vw - 432px)))`,
        top: `max(12px, min(${rect.bottom + 8}px, calc(100vh - 400px)))`,
        padding: 12,
        border: `1px solid ${UI_COLORS.border}`,
        borderRadius: 8,
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <div tabIndex={-1}>
        <strong>{value?.context.source.title ?? context.source.title}</strong>
      </div>
      <div style={{ fontSize: 12 }}>
        Reply to {destination}. Main composer stays unchanged.
      </div>
      {value?.context.image && (
        <div role="note">Whole-image snapshot will be attached.</div>
      )}
      {value?.context.quote && (
        <blockquote
          style={{ maxHeight: 100, overflow: "auto", whiteSpace: "pre-wrap" }}
        >
          {value.context.quote}
        </blockquote>
      )}
      {value?.submitted && (
        <div role="status">
          {sending
            ? "Sending to agent; waiting for backend confirmation..."
            : "Agent submission is not confirmed. Your comment is retained. Check status without sending again. Discarding this draft does not cancel a submission."}
        </div>
      )}
      <div ref={panel} inert={sending || value?.submitted}>
        {value ? (
          <MarkdownInput
            value={value.text}
            getValueRef={getValue}
            onChange={update}
            onSave={() => void send()}
            cacheId={`local-comment:${account_id}:${projectId}:${path}:${context.source.thread_id}:${context.source.id}`}
            autoGrow
            minimal
            compact
            hideHelp
            enableMentions={false}
            enableUpload={false}
          />
        ) : (
          <div role="status">Restoring private draft...</div>
        )}
      </div>
      {error && <Alert type="error" title={error} />}
      <Space wrap>
        <Button
          type="primary"
          loading={sending}
          disabled={!value?.text.trim()}
          onClick={() => void send()}
        >
          {sending
            ? "Sending..."
            : value?.submitted
              ? "Check send status"
              : "Send comment"}
        </Button>
        <Button disabled={sending} onClick={close}>
          Keep draft and close
        </Button>
        <Button
          disabled={sending}
          onClick={() => {
            void draft
              .clearInput()
              .then(onClose)
              .catch((err) => setError(String(err)));
          }}
        >
          Discard draft
        </Button>
      </Space>
    </KeyboardBoundary>,
    document.body,
  );
}
