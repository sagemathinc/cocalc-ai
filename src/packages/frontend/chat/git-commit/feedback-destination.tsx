import { Alert, Modal } from "antd";
import { useEffect, useRef, useState } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  AgentSessionSelect,
  AgentSessionError,
  isNewAgentThreadSelection,
  usePersistentAgentSessionSelection,
} from "@cocalc/frontend/frame-editors/ai/agent-session-selector";
import { submitNavigatorPromptInWorkspaceChat } from "@cocalc/frontend/project/new/navigator-intents";
import type { RequestComparisonAgentTurn } from "./comparison-feedback";

// Opening a review without a source thread requires an explicit destination.
// Keep the caller pending until delivery succeeds, so cancellation never marks
// comments submitted.
export function useFeedbackDestination(
  projectId: string | undefined,
  path: string | undefined,
  open: boolean,
) {
  const [pending, setPending] = useState<{
    prompt: string;
    title?: string;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  const current = useRef(pending);
  current.current = pending;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selection = usePersistentAgentSessionSelection({
    project_id: projectId ?? "",
    path: path ?? "",
    cacheContext: "git-review",
    enabled: pending != null,
  });
  useEffect(
    () => () => {
      current.current?.reject(new Error("Feedback destination closed."));
    },
    [],
  );
  useEffect(() => {
    if (!open && current.current) {
      current.current.reject(new Error("Feedback destination closed."));
      setPending(undefined);
    }
  }, [open]);
  const destinationAvailable =
    Boolean(selection.selectedAgentSession) ||
    isNewAgentThreadSelection(selection);
  const request: RequestComparisonAgentTurn = (prompt, options) =>
    new Promise<void>((resolve, reject) => {
      setError("");
      setPending({ prompt, title: options?.title, resolve, reject });
    });
  const cancel = () => {
    pending?.reject(new Error("Feedback was not sent."));
    setPending(undefined);
  };
  return {
    request: projectId && path ? request : undefined,
    modal: (
      <Modal
        title="Send review to agent"
        modalRender={(node) => (
          <KeyboardBoundary boundary="git-review-feedback">
            {node}
          </KeyboardBoundary>
        )}
        open={pending != null}
        okText="Send feedback"
        confirmLoading={busy}
        okButtonProps={{ disabled: !destinationAvailable || selection.loading }}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        mask={{ closable: !busy }}
        keyboard={!busy}
        onCancel={cancel}
        onOk={async () => {
          if (!pending || busy || !destinationAvailable || !projectId || !path)
            return;
          setBusy(true);
          setError("");
          try {
            const sent = await submitNavigatorPromptInWorkspaceChat({
              project_id: projectId,
              path,
              prompt: pending.prompt,
              title: pending.title ?? "Git review",
              forceCodex: true,
              openFloating: true,
              waitForAgent: false,
              agentSession: selection.selectedAgentSession,
              createNewThread: isNewAgentThreadSelection(selection),
            });
            if (!sent) throw new Error("Unable to send review feedback.");
            selection.saveSelectedAgentSession();
            pending.resolve();
            setPending(undefined);
          } catch (err) {
            setError(String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <AgentSessionSelect
          selection={selection}
          disabled={busy}
          includeNewThreadOption
        />
        <AgentSessionError selection={selection} />
        {error && <Alert type="error" title={error} />}
      </Modal>
    ),
  };
}
