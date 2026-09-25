import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { LibraryArtifactView } from "./library-artifact-view";
import { useArtifactNames } from "./artifact-names";
import { openLibrary } from "./library-navigation";
import { useNavigationIntent } from "./use-navigation-intent";

interface Props {
  accountId: string;
  projectId: string;
  entryId: string;
  agents: NamedAgent[];
  onBack: () => void;
  onShowConversation: (target: ForeignArtifactTarget) => Promise<void>;
  navigation?: ReactNode;
}

export function LibraryEntry(props: Props) {
  // A route/account change must discard old content before the next paint.
  return (
    <ResolvedLibraryEntry
      key={JSON.stringify([props.accountId, props.projectId, props.entryId])}
      {...props}
    />
  );
}

function ResolvedLibraryEntry({
  accountId,
  projectId,
  entryId,
  agents,
  onBack,
  onShowConversation,
  navigation,
}: Props) {
  const navigationIntent = useNavigationIntent(true, accountId);
  const back = () => {
    navigationIntent.current++;
    onBack();
  };
  const { names, setName, resolve } = useArtifactNames();
  const [entry, setEntry] = useState<CatalogEntry>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setEntry(undefined);
    setError("");
    void (async () => {
      const alias = entryId ? undefined : await resolve(projectId);
      if (!entryId && !alias)
        throw Error("This artifact name was not found in your account.");
      const resolvedProjectId = alias?.project_id ?? projectId;
      const resolvedEntryId = alias?.entry_id ?? entryId;
      if (!resolvedEntryId) throw Error("Missing artifact identity.");
      const value =
        await webapp_client.conat_client.hub.artifactCatalog.getEntry({
          project_id: resolvedProjectId,
          entry_id: resolvedEntryId,
        });
      if (
        value &&
        (value.project_id !== resolvedProjectId ||
          value.entry_id !== resolvedEntryId)
      )
        throw Error("The catalog returned a different artifact.");
      return value;
    })()
      .then((value) => {
        if (disposed) return;
        if (!value) throw Error("This artifact is no longer in the catalog.");
        setEntry(value);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [projectId, entryId, retry]);

  if (!entry) {
    return (
      <section aria-label="Library artifact" style={{ padding: 16 }}>
        <Button type="text" onClick={back}>
          Back to Library
        </Button>
        {error ? (
          <Alert
            role="alert"
            type="warning"
            title="Artifact unavailable"
            description={error}
            action={
              <Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>
            }
          />
        ) : (
          <div role="status">Loading artifact...</div>
        )}
      </section>
    );
  }
  const agent = agents.find(
    (candidate) =>
      candidate.endpoint.project_id === entry.project_id &&
      candidate.path === entry.chat_path &&
      candidate.thread_id === entry.item.thread_id,
  );
  const target: ForeignArtifactTarget = {
    projectId: entry.project_id,
    path: entry.chat_path,
    threadId: entry.item.thread_id,
    artifactId: entry.item.artifact_id,
    agentId: agent?.endpoint.agent_id,
  };
  return (
    <LibraryArtifactView
      navigation={navigation}
      target={target}
      artifactName={
        names.find(
          (item) =>
            item.active &&
            item.project_id === entry.project_id &&
            item.entry_id === entry.entry_id,
        )?.name
      }
      onName={async (name) => {
        const intent = ++navigationIntent.current;
        await setName(
          { project_id: entry.project_id, entry_id: entry.entry_id },
          name,
        );
        if (intent !== navigationIntent.current) return;
        await openLibrary(name);
      }}
      onBack={back}
      onShowConversation={() => {
        navigationIntent.current++;
        return onShowConversation({
          ...target,
          publicationId: entry.item.publication.operation_id,
        });
      }}
    />
  );
}
