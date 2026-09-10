import { useEffect, useRef } from "react";
import { Alert, Button, Space } from "antd";
import { readArtifact, validateArtifactFeedback } from "@cocalc/chat";
import type { ArtifactFeedback } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import {
  useChatComposerDraft,
  writeChatComposerDraft,
} from "./use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "./utils";
import { ActionReviewNotice } from "./artifact-feedback-notice";

const suffix = "artifact-feedback";

export function useArtifactFeedbackDraft({
  actions,
  account_id,
  project_id,
  path,
  composerDraftKey,
  threadId,
}: {
  actions: ChatActions;
  account_id?: string;
  project_id: string;
  path: string;
  composerDraftKey: number;
  threadId?: string | null;
}) {
  const draft = useChatComposerDraft({
    account_id,
    project_id,
    path,
    composerDraftKey,
    suffix,
  });
  const knownDrafts = useRef(new Map<number, string>());
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  if (!draft.input) knownDrafts.current.set(composerDraftKey, "");
  else {
    try {
      if (JSON.parse(draft.input).thread_id === threadId) {
        knownDrafts.current.set(composerDraftKey, draft.input);
      }
    } catch {
      /* Keep invalid drafts visible; never clear them as a sent snapshot. */
    }
  }
  useEffect(() => {
    const stage = async (value: ArtifactFeedback) => {
      const feedback = validateArtifactFeedback(value);
      if (!actions.syncdb) throw Error("Chat is not connected");
      readArtifact(actions.syncdb, feedback);
      const serialized = JSON.stringify(feedback);
      const targetKey = stableDraftKeyFromThreadKey(feedback.thread_id);
      if (feedback.thread_id === threadId) {
        knownDrafts.current.set(composerDraftKey, serialized);
        draft.setInput(serialized);
      } else {
        await writeChatComposerDraft({
          account_id,
          project_id,
          path,
          suffix,
          composerDraftKey: targetKey,
          text: serialized,
        });
        knownDrafts.current.set(targetKey, serialized);
        actions.setSelectedThread?.(feedback.thread_id);
      }
    };
    actions.stageArtifactFeedback = stage;
    return () => {
      if (actions.stageArtifactFeedback === stage)
        actions.stageArtifactFeedback = undefined;
    };
  }, [
    actions,
    account_id,
    project_id,
    path,
    threadId,
    composerDraftKey,
    draft.setInput,
  ]);

  const read = (): ArtifactFeedback | undefined => {
    if (!draft.input) return;
    const feedback = validateArtifactFeedback(JSON.parse(draft.input));
    if (feedback.thread_id !== threadId)
      throw Error("Artifact feedback belongs to a different thread");
    if (!actions.syncdb) throw Error("Chat is not connected");
    readArtifact(actions.syncdb, feedback);
    return feedback;
  };
  let feedback: ArtifactFeedback | undefined;
  let error = "";
  try {
    feedback = read();
  } catch (err) {
    error = String(err);
  }
  return {
    read,
    clear: async (submitted: ArtifactFeedback) => {
      const expected = JSON.stringify(validateArtifactFeedback(submitted));
      if (knownDrafts.current.get(composerDraftKey) !== expected) return;
      knownDrafts.current.delete(composerDraftKey);
      // Use the latest callback: the composer may have switched controller/key
      // while Send was awaiting its outbox write.
      await latestDraft.current.clearComposerDraft(composerDraftKey);
    },
    control: draft.input ? (
      <Space wrap style={{ padding: "4px 12px" }}>
        {error ? (
          <Alert type="warning" message={error} />
        ) : feedback?.action_review ? (
          <ActionReviewNotice
            title={feedback.title}
            decisions={feedback.action_review}
          />
        ) : (
          <span>
            Feedback on <strong>{feedback?.title}</strong>
            {feedback?.quote
              ? `: ${feedback.quote.slice(0, 100)}`
              : " (whole document)"}
          </span>
        )}
        <Button
          size="small"
          onClick={() => {
            void draft.clearInput();
            // The removal button disappears; leave the keyboard in this composer.
            if (actions.frameId != null) {
              actions.frameTreeActions?.focus(actions.frameId);
            }
          }}
        >
          Remove artifact feedback
        </Button>
      </Space>
    ) : null,
  };
}
