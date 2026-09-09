import { useEffect } from "react";
import { Alert, Button, Space } from "antd";
import { readArtifact, validateArtifactFeedback } from "@cocalc/chat";
import type { ArtifactFeedback } from "@cocalc/chat";
import type { ChatActions } from "./actions";
import {
  useChatComposerDraft,
  writeChatComposerDraft,
} from "./use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "./utils";

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
  useEffect(() => {
    const stage = async (value: ArtifactFeedback) => {
      const feedback = validateArtifactFeedback(value);
      if (!actions.syncdb) throw Error("Chat is not connected");
      readArtifact(actions.syncdb, feedback);
      const serialized = JSON.stringify(feedback);
      if (feedback.thread_id === threadId) draft.setInput(serialized);
      else {
        await writeChatComposerDraft({
          account_id,
          project_id,
          path,
          suffix,
          composerDraftKey: stableDraftKeyFromThreadKey(feedback.thread_id),
          text: serialized,
        });
        actions.setSelectedThread?.(feedback.thread_id);
      }
    };
    actions.stageArtifactFeedback = stage;
    return () => {
      if (actions.stageArtifactFeedback === stage)
        actions.stageArtifactFeedback = undefined;
    };
  }, [actions, account_id, project_id, path, threadId, draft.setInput]);

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
    clear: () => draft.clearComposerDraft(composerDraftKey),
    control: draft.input ? (
      <Space wrap style={{ padding: "4px 12px" }}>
        {error ? (
          <Alert type="warning" message={error} />
        ) : (
          <span>
            Feedback on <strong>{feedback?.title}</strong>
            {feedback?.quote
              ? `: ${feedback.quote.slice(0, 100)}`
              : " (whole document)"}
          </span>
        )}
        <Button size="small" onClick={() => void draft.clearInput()}>
          Remove artifact feedback
        </Button>
      </Space>
    ) : null,
  };
}
