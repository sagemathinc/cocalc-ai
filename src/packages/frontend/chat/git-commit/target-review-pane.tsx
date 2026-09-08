import { Alert, Button, Checkbox, Input } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GitSource,
  ImmutableReviewTarget,
} from "@cocalc/frontend/components/diff-viewer/review-model";
import { reviewTargetKey } from "@cocalc/frontend/components/diff-viewer/review-model";
import { ChangedFilesLayout } from "@cocalc/frontend/components/diff-viewer/changed-files-layout";
import { projectGitReader } from "@cocalc/frontend/git/project-read-service";
import { readTargetDiff } from "@cocalc/frontend/git/read-target-diff";
import {
  dispatchWorktreeFeedback,
  validateAgentWorktree,
} from "@cocalc/frontend/git/agent-worktree";
import { comparisonFeedbackPrompt } from "./comparison-feedback";
import type { RequestComparisonAgentTurn } from "./comparison-feedback";
import { WorktreeAgentConsent } from "./worktree-agent-consent";
import { applySubmittedGitReviewComments } from "./review-state";
import {
  loadTargetReview,
  saveTargetReview,
  exportTargetReview,
  importTargetReview,
} from "../git-target-review-store";
import { buildGitDiffFindMatches } from "./diff-find";
import type {
  TargetReviewBody,
  TargetReviewRevision,
} from "../git-target-review-store";
import type { GitReviewCommentV2 } from "../git-review-store";
import type { CommentAnchor, GitShowParsed } from "./types";
import type { ReviewDiffNavigation } from "./review-diff-panel";
import PierreReviewPanel from "./pierre-review-panel";
import {
  getEventPath,
  isEditableOrKeyboardInteractiveTarget,
} from "@cocalc/frontend/keyboard/boundary";
import {
  matchGitDrawerScrollCommand,
  runGitDrawerScrollCommand,
} from "./drawer-scroll";

type Draft = {
  body: TargetReviewBody;
  parents: string[];
  editor?: { anchor?: CommentAnchor; id?: string; text: string };
};
const empty = (): TargetReviewBody => ({
  reviewed: false,
  note: "",
  comments: {},
});

export function TargetReviewPane({
  target,
  accountId,
  fontSize,
  onView,
  onEditing,
  onLeave,
  onRequestAgentTurn,
}: {
  target: ImmutableReviewTarget;
  accountId: string;
  fontSize: number;
  onView: (source: GitSource) => void;
  onEditing: (editing: boolean) => void;
  onLeave: () => void;
  onRequestAgentTurn?: RequestComparisonAgentTurn;
}) {
  const scope = reviewTargetKey(target);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const prefix = `cocalc:git-target-draft:v1:${JSON.stringify([accountId, scope])}:`;
  const writer = useRef(crypto.randomUUID());
  const key = prefix + writer.current;
  const [draft, setDraft] = useState<Draft>({ body: empty(), parents: [] });
  const current = useRef(draft);
  const [heads, setHeads] = useState<TargetReviewRevision[]>([]);
  const [recovered, setRecovered] = useState<
    Array<{ key: string; draft: Draft }>
  >([]);
  const [data, setData] = useState<GitShowParsed>();
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [localStored, setLocalStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [agentConsent, setAgentConsent] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const [activeFile, setActiveFile] = useState(0);
  const navigationRef = useRef<ReviewDiffNavigation | null>(null);
  const unusedRef = useRef(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const matches = useMemo(
    () => buildGitDiffFindMatches({ data, query }),
    [data, query],
  );
  const activeMatch = matches.length
    ? matches[matchIndex % matches.length]
    : undefined;
  const matchCounts = new Map<number, number>();
  const matchedLines = new Map<number, Set<number>>();
  for (const match of matches) {
    matchCounts.set(
      match.fileIndex,
      (matchCounts.get(match.fileIndex) ?? 0) + 1,
    );
    if (match.lineIndex != null) {
      const lines = matchedLines.get(match.fileIndex) ?? new Set<number>();
      lines.add(match.lineIndex);
      matchedLines.set(match.fileIndex, lines);
    }
  }
  const moveMatch = (delta: number) =>
    setMatchIndex((index) =>
      matches.length ? (index + delta + matches.length) % matches.length : 0,
    );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const diff = await readTargetDiff(projectGitReader, target, 3);
        if (!cancelled) setData(diff);
        const drafts: Array<{ key: string; draft: Draft }> = [];
        for (let i = 0; i < localStorage.length; i++) {
          const oldKey = localStorage.key(i)!;
          if (!oldKey.startsWith(prefix) || oldKey === key) continue;
          try {
            const value = JSON.parse(localStorage.getItem(oldKey)!);
            if (
              value?.body &&
              typeof value.body.note === "string" &&
              value.body.comments &&
              typeof value.body.comments === "object" &&
              !Array.isArray(value.body.comments) &&
              Array.isArray(value.parents) &&
              value.parents.every((id: unknown) => typeof id === "string")
            )
              drafts.push({ key: oldKey, draft: value });
          } catch {
            /* Leave unreadable drafts untouched. */
          }
        }
        setRecovered(drafts);
        const reviews = await loadTargetReview({ accountId, target });
        if (cancelled) return;
        setHeads(reviews.heads);
        const saved = reviews.heads.length === 1 ? reviews.heads[0] : undefined;
        const initial = {
          body: saved?.body ?? empty(),
          parents: saved ? [saved.id] : [],
        };
        current.current = initial;
        setDraft(initial);
        setReady(true);
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
      onEditing(false);
    };
  }, [target, accountId, prefix, key, onEditing]);
  const change = (next: Draft) => {
    if (saving.current) return;
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setLocalStored(true);
    } catch {
      setLocalStored(false);
      setError(
        "Local draft storage failed. Keep this window open and save the review.",
      );
    }
    current.current = next;
    setDraft(next);
    setDirty(true);
  };
  useEffect(() => {
    onEditing(Boolean(draft.editor) || busy || dirty);
  }, [draft.editor, busy, dirty, onEditing]);
  const updateComment = async (
    id: string,
    update: Partial<GitReviewCommentV2>,
  ) => {
    const old = current.current.body.comments[id];
    if (!old) return;
    change({
      ...current.current,
      editor: undefined,
      body: {
        ...current.current.body,
        comments: {
          ...current.current.body.comments,
          [id]: {
            ...old,
            ...update,
            updated_at: Date.now(),
            local_revision: old.local_revision + 1,
          },
        },
      },
    });
  };
  const save = async (reconcile: boolean) => {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      const saved = await saveTargetReview({
        accountId,
        target,
        body: current.current.body,
        parents: reconcile
          ? heads.map((head) => head.id)
          : current.current.parents,
      });
      const next = { body: saved.body, parents: [saved.id] };
      current.current = next;
      setDraft(next);
      setDirty(false);
      localStorage.removeItem(key);
      setHeads((await loadTargetReview({ accountId, target })).heads);
    } catch (err) {
      setError(String(err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !onRequestAgentTurn ||
      !agentConsent ||
      !ready ||
      dirty ||
      saving.current ||
      current.current.editor ||
      heads.length !== 1
    )
      return;
    saving.current = true;
    setBusy(true);
    setError("");
    const snapshot = current.current;
    let sent = false;
    try {
      const latest = await loadTargetReview({ accountId, target });
      if (
        latest.heads.length !== 1 ||
        latest.heads[0].id !== snapshot.parents[0]
      )
        throw Error(
          "The saved review changed. Reload and reconcile before sending feedback.",
        );
      const head = target.kind === "commit" ? target.commit : target.head;
      await dispatchWorktreeFeedback({
        prompt: comparisonFeedbackPrompt(target, snapshot.body),
        title: "Address comparison review",
        send: onRequestAgentTurn,
        isCurrent: () => mounted.current && activeScope.current === scope,
        validate: async () => {
          projectGitReader.invalidateDiscovery(target.repository.projectId);
          const discovered = await projectGitReader.discover(
            target.repository.projectId,
            target.repository.locator,
          );
          const tree = discovered.worktrees.find(
            (tree) => tree.path === target.repository.locator,
          );
          return validateAgentWorktree(
            projectGitReader,
            target.repository,
            target.repository.locator,
            head,
            head,
            tree?.branch,
          );
        },
      });
      sent = true;
      const now = Date.now();
      const submissionId = `git-comparison-${crypto.randomUUID()}`;
      const body = {
        ...snapshot.body,
        comments: applySubmittedGitReviewComments({
          sentComments: Object.values(snapshot.body.comments).filter(
            (comment) => comment.status === "draft",
          ),
          currentComments: snapshot.body.comments,
          submittedAt: now,
          submissionTurnId: submissionId,
        }),
        last_submitted_at: now,
        last_submission_turn_id: submissionId,
      };
      // Preserve the receipt locally even if persisting its revision fails.
      const receiptDraft = { body, parents: snapshot.parents };
      current.current = receiptDraft;
      setDraft(receiptDraft);
      setDirty(true);
      try {
        localStorage.setItem(key, JSON.stringify(receiptDraft));
        setLocalStored(true);
      } catch {
        setLocalStored(false);
      }
      const saved = await saveTargetReview({
        accountId,
        target,
        body,
        parents: snapshot.parents,
      });
      current.current = { body: saved.body, parents: [saved.id] };
      setDraft(current.current);
      setHeads((await loadTargetReview({ accountId, target })).heads);
      setDirty(false);
      localStorage.removeItem(key);
    } catch (err) {
      setError(
        `${sent ? "Feedback was sent, but saving its receipt failed. Do not resend; save the local review instead. " : ""}${String(err)}`,
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const comments = useMemo(() => {
    const result = new Map<string, GitReviewCommentV2[]>();
    for (const comment of Object.values(draft.body.comments))
      result.set(comment.file_path, [
        ...(result.get(comment.file_path) ?? []),
        comment,
      ]);
    return result;
  }, [draft.body.comments]);
  const transfer = async (file?: File) => {
    if (saving.current) return;
    if (file && (dirty || current.current.editor)) {
      setError(
        "Finish and save the current edits before importing an archive.",
      );
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      if (file) {
        if (file.size > 10_000_000) throw Error("Review archive exceeds 10 MB");
        await importTargetReview({
          accountId,
          target,
          payload: JSON.parse(await file.text()),
        });
        setHeads((await loadTargetReview({ accountId, target })).heads);
      } else {
        const saved = await loadTargetReview({ accountId, target });
        const url = URL.createObjectURL(
          new Blob(
            [JSON.stringify(exportTargetReview(saved.revisions), null, 2)],
            { type: "application/json" },
          ),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "git-comparison-review.json";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  if (!data) return <div role="status">{error || "Loading comparison..."}</div>;
  const editor = draft.editor;
  return (
    <section
      aria-label="Comparison review"
      onKeyDown={(event) => {
        const native = event.nativeEvent;
        if (event.defaultPrevented || native.isComposing) return;
        if (
          (event.ctrlKey || event.metaKey) &&
          !event.altKey &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          event.stopPropagation();
          searchInput.current?.focus();
          return;
        }
        const path = getEventPath(native);
        const viewport = navigationRef.current?.viewport();
        if (
          !viewport ||
          !path.includes(viewport) ||
          path.some(isEditableOrKeyboardInteractiveTarget)
        )
          return;
        const command = matchGitDrawerScrollCommand(native);
        if (!command) return;
        event.preventDefault();
        event.stopPropagation();
        runGitDrawerScrollCommand(viewport, command);
      }}
    >
      <p
        className="git-review-target-summary"
        title={
          target.kind === "comparison"
            ? `${target.mode}: ${target.base} to ${target.head}`
            : target.commit
        }
        style={{ overflowWrap: "anywhere" }}
      >
        {target.kind === "comparison"
          ? `${target.base.slice(0, 10)} → ${target.head.slice(0, 10)} · ${data.files.length} files changed`
          : `${target.commit} versus parent ${target.parentIndex + 1} (${target.parent ?? "empty tree"})`}
      </p>
      {error && (
        <Alert
          type="error"
          title="Review operation failed"
          description={error}
        />
      )}
      {heads.length > 1 && (
        <Alert
          type="warning"
          title="Concurrent review versions"
          description="No version was overwritten. Inspect the versions below and explicitly reconcile their contents before saving a combined review."
        />
      )}
      {heads.length > 1 &&
        heads.map((head) => (
          <details key={head.id}>
            <summary>
              Version {head.id} ({Object.keys(head.body.comments).length}{" "}
              comments)
            </summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(head.body, null, 2)}
            </pre>
            <Button
              disabled={dirty || busy || Boolean(editor)}
              onClick={() => {
                const next = { body: head.body, parents: [head.id] };
                current.current = next;
                setDraft(next);
              }}
            >
              Use this version
            </Button>
          </details>
        ))}
      {recovered.map((entry, i) => (
        <span key={entry.key}>
          <Button
            disabled={dirty || busy || (!ready && !error)}
            onClick={() => {
              change(entry.draft);
              setReady(true);
            }}
          >
            Recover local draft {i + 1}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              if (
                localStorage.getItem(entry.key) !== JSON.stringify(entry.draft)
              ) {
                setError(
                  "This draft changed in another window; it was not deleted.",
                );
                return;
              }
              localStorage.removeItem(entry.key);
              setRecovered(recovered.filter((item) => item.key !== entry.key));
            }}
          >
            Discard local draft {i + 1}
          </Button>
        </span>
      ))}
      <details className="git-review-disclosure">
        <summary>
          Review note{draft.body.note.trim() ? " (has content)" : ""}
        </summary>
        <label>
          Review note{" "}
          <Input.TextArea
            aria-label="Comparison review note"
            disabled={!ready || busy}
            value={draft.body.note}
            onChange={(event) =>
              change({
                ...draft,
                body: { ...draft.body, note: event.target.value },
              })
            }
            style={{ width: "100%" }}
          />
        </label>
      </details>
      <Checkbox
        disabled={!ready || busy}
        checked={draft.body.reviewed}
        onChange={(event) =>
          change({
            ...draft,
            body: { ...draft.body, reviewed: event.target.checked },
          })
        }
      >
        Reviewed this comparison
      </Checkbox>{" "}
      <Button
        disabled={!ready || busy || Boolean(editor)}
        onClick={() => void save(false)}
      >
        Save review
      </Button>{" "}
      {onRequestAgentTurn && (
        <>
          <WorktreeAgentConsent
            path={target.repository.locator}
            checked={agentConsent}
            disabled={busy}
            onChange={setAgentConsent}
          />
          <Button
            disabled={
              !ready ||
              busy ||
              dirty ||
              Boolean(editor) ||
              !agentConsent ||
              heads.length !== 1 ||
              (!draft.body.note.trim() &&
                !Object.values(draft.body.comments).some(
                  (comment) => comment.status === "draft",
                ))
            }
            onClick={() => void submit()}
          >
            Send saved review to agent
          </Button>
          <div>
            The working copy must still be at the comparison's head revision.
          </div>
        </>
      )}
      <details className="git-review-disclosure">
        <summary>Import / export review</summary>
        <Button
          disabled={!ready || busy || Boolean(editor)}
          onClick={() => void transfer()}
        >
          Export saved versions
        </Button>{" "}
        <Button
          disabled={!ready || busy || dirty || Boolean(editor)}
          onClick={() => importInput.current?.click()}
        >
          Import review archive
        </Button>
      </details>
      <input
        ref={importInput}
        type="file"
        accept="application/json,.json"
        aria-label="Review archive file"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void transfer(file);
        }}
      />
      {dirty && (
        <Button
          disabled={!localStored || busy || Boolean(editor)}
          onClick={onLeave}
        >
          Keep local draft and close
        </Button>
      )}
      {heads.length > 1 && (
        <Button
          disabled={!ready || busy || Boolean(editor)}
          onClick={() => void save(true)}
        >
          Save reconciliation of loaded versions
        </Button>
      )}
      {!data.files.length && (
        <Alert type="info" title="No changes between these pinned endpoints" />
      )}
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "8px 0" }}
      >
        <label>
          Search loaded diff{" "}
          <input
            ref={searchInput}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                moveMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
        </label>
        <Button disabled={!matches.length} onClick={() => moveMatch(-1)}>
          Previous match
        </Button>
        <Button disabled={!matches.length} onClick={() => moveMatch(1)}>
          Next match
        </Button>
        <span role="status">
          {query
            ? `${activeMatch ? (matchIndex % matches.length) + 1 : 0} of ${matches.length} matches`
            : "Search includes filenames and loaded patch lines, not omitted context."}
        </span>
      </div>
      <ChangedFilesLayout
        expansionScope={JSON.stringify([accountId, scope])}
        files={data.files.map((file, index) => ({
          id: String(index),
          path: file.path,
          commentCount: comments.get(file.path)?.length,
        }))}
        activeId={String(activeFile)}
        onSelect={(id) => navigationRef.current?.navigateToFile(Number(id))}
      >
        <PierreReviewPanel
          files={data.files}
          fontSize={fontSize}
          reviewEditorScope={JSON.stringify([accountId, scope])}
          scrollScope={JSON.stringify([accountId, scope])}
          firstParentProvenance={false}
          inlineCommentsByFile={comments}
          showResolvedComments={true}
          isHeadSelected={false}
          commentingDisabled={!ready || busy}
          visibleDiffLinesByFile={{}}
          drawerScrollParent={null}
          virtuosoRef={unusedRef}
          navigationRef={navigationRef}
          onActiveFile={setActiveFile}
          linesTruncated={data.linesTruncated}
          repoRoot={target.repository.locator}
          onOpenFile={async () => {}}
          onViewFile={(path, side) => {
            const file = data.files.find((file) => file.path === path);
            const source =
              side === "old"
                ? file?.oldSource
                : side === "new"
                  ? file?.newSource
                  : (file?.newSource ?? file?.oldSource);
            if (source) onView(source);
          }}
          onShowMoreLines={() => {}}
          activeDraft={editor?.anchor}
          activeDraftBody={editor?.anchor ? editor.text : ""}
          activeEditingId={editor?.id}
          activeEditingBody={editor?.id ? editor.text : ""}
          pendingKey={busy ? "saving" : ""}
          onOpenDraft={(anchor) =>
            change({
              ...draft,
              editor: {
                anchor: {
                  ...anchor,
                  side: anchor.side === "context" ? "new" : anchor.side,
                },
                text: "",
              },
            })
          }
          onDraftBodyChange={(text) =>
            change({ ...draft, editor: { ...editor!, text } })
          }
          onCancelDraft={() => change({ ...draft, editor: undefined })}
          onOpenEdit={(comment) =>
            change({
              ...draft,
              editor: { id: comment.id, text: comment.body_md },
            })
          }
          onEditingBodyChange={(text) =>
            change({ ...draft, editor: { ...editor!, text } })
          }
          onCancelEdit={() => change({ ...draft, editor: undefined })}
          onCreateComment={async (anchor, text) => {
            const id = crypto.randomUUID();
            const now = Date.now();
            change({
              ...current.current,
              editor: undefined,
              body: {
                ...current.current.body,
                comments: {
                  ...current.current.body.comments,
                  [id]: {
                    id,
                    file_path: anchor.filePath,
                    side: anchor.side,
                    line: anchor.line,
                    hunk_header: anchor.hunk_header,
                    hunk_hash: anchor.hunk_hash,
                    snippet: anchor.snippet,
                    body_md: text,
                    status: "draft",
                    created_at: now,
                    updated_at: now,
                    local_revision: 1,
                  },
                },
              },
            });
          }}
          onUpdateComment={(id, text) => updateComment(id, { body_md: text })}
          onResolveComment={(id) => updateComment(id, { status: "resolved" })}
          onReopenComment={(id) => updateComment(id, { status: "draft" })}
          diffFindMatchCounts={matchCounts}
          diffFindMatchedLineIndexes={matchedLines}
          activeDiffFindMatch={activeMatch}
        />
      </ChangedFilesLayout>
    </section>
  );
}
