/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { FilesystemClient } from "@cocalc/conat/files/fs";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";
import { checked_three_way_merge } from "@cocalc/util/dmp";
import {
  forwardRef,
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from "react";
import type { CodeMirrorEditorHandle } from "./codemirror-editor";
import { sha256Text } from "./sha256";
import type { UltraliteSession } from "./session";
import {
  languageForPath,
  loadLanguage,
  Prism,
  type UltraliteLanguage,
} from "./prism-languages";
import { ULTRALITE_BEFORE_NAVIGATE } from "./routes";
import {
  recordUltraliteFailure,
  recordUltraliteOutcome,
  recordUltraliteSurfaceReady,
} from "./telemetry";
import { InlineAlert, LoadingState } from "./ui";
import useEditCheckpoint from "./use-edit-checkpoint";
import type {
  ExternalMergeHandle,
  ExternalMergeResult,
} from "./external-merge";

function tokenClass(token: Prism.Token): string {
  const aliases = Array.isArray(token.alias)
    ? token.alias
    : token.alias
      ? [token.alias]
      : [];
  return ["token", token.type, ...aliases].join(" ");
}

function renderTokens(tokens: Array<string | Prism.Token>, key = "t") {
  return tokens.map((token, index): ReactNode => {
    const tokenKey = `${key}-${index}`;
    if (typeof token === "string") {
      return <Fragment key={tokenKey}>{token}</Fragment>;
    }
    const content = Array.isArray(token.content)
      ? renderTokens(token.content, tokenKey)
      : token.content instanceof Prism.Token
        ? renderTokens([token.content], tokenKey)
        : token.content;
    return (
      <span className={tokenClass(token)} key={tokenKey}>
        {content}
      </span>
    );
  });
}

function HighlightedCode({
  contents,
  language,
  wrap,
}: {
  contents: string;
  language?: UltraliteLanguage;
  wrap: boolean;
}) {
  const [grammar, setGrammar] = useState<Prism.Grammar>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setGrammar(undefined);
    setFailed(false);
    void loadLanguage(language)
      .then((value) => {
        if (!cancelled) setGrammar(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  let children: ReactNode = contents;
  if (grammar && language) {
    children = renderTokens(Prism.tokenize(contents, grammar));
  }
  return (
    <>
      {language && !grammar && !failed ? (
        <LoadingState label="Loading syntax highlighting" />
      ) : null}
      {failed ? (
        <InlineAlert kind="warning">
          Syntax highlighting could not be loaded. Plain text is still safe and
          available.
        </InlineAlert>
      ) : null}
      <pre className={`ul-code-view ${wrap ? "ul-code-wrap" : ""}`}>
        <code>{children}</code>
      </pre>
    </>
  );
}

const LazyCodeMirrorEditor = lazy(
  () =>
    new Promise<{ default: typeof import("./codemirror-editor").default }>(
      (resolve, reject) => {
        if (process.env.COCALC_TEST_MODE) {
          resolve({ default: require("./codemirror-editor").default });
          return;
        }
        require.ensure(
          [],
          () => resolve({ default: require("./codemirror-editor").default }),
          reject,
          "ultralite-codemirror",
        );
      },
    ),
);

const LazyMarkdownView = lazy(
  () =>
    new Promise<{ default: typeof import("./markdown-view").default }>(
      (resolve, reject) => {
        if (process.env.COCALC_TEST_MODE) {
          resolve({ default: require("./markdown-view").default });
          return;
        }
        require.ensure(
          [],
          () => resolve({ default: require("./markdown-view").default }),
          reject,
          "ultralite-markdown-view",
        );
      },
    ),
);

interface CodeViewProps {
  contents: string;
  externalChanged?: boolean;
  filesystem: FilesystemClient;
  onDirtyChange: (dirty: boolean) => void;
  onEditingChange?: (editing: boolean) => void;
  onExternalConflict?: () => void;
  onSaved: (contents: string) => void;
  path: string;
  project?: AccountProjectListWindowRow;
  readOnly: boolean;
  session?: UltraliteSession;
}

function CodeView(
  {
    contents,
    externalChanged = false,
    filesystem,
    onDirtyChange,
    onEditingChange,
    onExternalConflict,
    onSaved,
    path,
    project,
    readOnly,
    session,
  }: CodeViewProps,
  ref: ForwardedRef<ExternalMergeHandle>,
) {
  const [base, setBase] = useState(contents);
  const [draft, setDraft] = useState(contents);
  const editorRef = useRef<CodeMirrorEditorHandle>(null);
  const journalId = useRef(crypto.randomUUID());
  const journalSequence = useRef(0);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editRevision, setEditRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mergeNeedsReview, setMergeNeedsReview] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [cursor, setCursor] = useState("Ln 1, Col 1");
  const [wrap, setWrap] = useState(false);
  const language = languageForPath(path);

  useEffect(() => {
    setBase(contents);
    setDraft(contents);
    setDirty(false);
    setConflict(false);
    setMergeNeedsReview(false);
    setError(undefined);
    setNotice(undefined);
  }, [contents, path]);

  useImperativeHandle(
    ref,
    (): ExternalMergeHandle => ({
      mergeExternal(remote): ExternalMergeResult {
        const local = editorRef.current?.getValue() ?? draft;
        const result = checked_three_way_merge({ base, local, remote });
        if (!result.clean) {
          setConflict(true);
          setError(
            "Automatic merging was unsafe because both versions changed the same text. Your draft is unchanged; use Full CoCalc to resolve the conflict.",
          );
          setNotice(undefined);
          return {
            clean: false,
            message:
              "Automatic merging was unsafe. Your draft was retained unchanged.",
          };
        }
        const nextDirty = result.merged !== remote;
        editorRef.current?.rebaseValue(remote, result.merged);
        setBase(remote);
        setDraft(result.merged);
        setDirty(nextDirty);
        setConflict(false);
        setMergeNeedsReview(nextDirty);
        setError(undefined);
        setNotice(
          nextDirty
            ? "Disk changes were merged into your draft. Review the result, then save it."
            : "The latest disk version is now loaded.",
        );
        return { clean: true, dirty: nextDirty };
      },
    }),
    [base, draft],
  );

  useEffect(() => {
    onDirtyChange(dirty);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeNavigate = (event: Event) => {
      if (dirty && !window.confirm("Discard unsaved changes?")) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(ULTRALITE_BEFORE_NAVIGATE, beforeNavigate);
    return () => {
      onDirtyChange(false);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(ULTRALITE_BEFORE_NAVIGATE, beforeNavigate);
    };
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (editing) recordUltraliteSurfaceReady("editor");
  }, [editing]);

  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);

  const save = async () => {
    if (!dirty || saving || conflict || externalChanged || readOnly) return;
    const next = editorRef.current?.getValue() ?? draft;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const batch = editorRef.current?.getJournalBatch?.();
      let saved = next;
      let savedWithJournal = false;
      if (batch && project?.host_id && session) {
        const { editJournalAvailable, saveTextJournal } =
          await import("@cocalc/conat/project/edit-journal");
        const lease = await session.openProjectHost(
          project.project_id,
          project.host_id,
        );
        if (
          await editJournalAvailable({
            client: lease.client,
            account_id: session.accountId,
            project_id: project.project_id,
          })
        ) {
          const response = await saveTextJournal({
            client: lease.client,
            account_id: session.accountId,
            project_id: project.project_id,
            request: {
              path,
              base_sha256: await sha256Text(batch.base),
              journal_id: journalId.current,
              sequence: journalSequence.current,
              patch: batch.patch,
            },
          });
          journalSequence.current += 1;
          saved = response.contents;
          savedWithJournal = true;
          editorRef.current?.acknowledgeJournal(saved);
        }
      }
      if (!savedWithJournal) {
        await filesystem.writeFileIfUnchanged(path, next, base, true);
        editorRef.current?.markClean();
      }
      setBase(saved);
      setDraft(saved);
      setDirty(false);
      setMergeNeedsReview(false);
      onSaved(saved);
      setNotice("Saved.");
      recordUltraliteOutcome("editor", "file_save");
    } catch (err: any) {
      recordUltraliteFailure("editor", err);
      if (err?.code === "ETAG_MISMATCH") {
        recordUltraliteOutcome("editor", "save_conflict");
        setConflict(true);
        onExternalConflict?.();
        setError(
          "This file changed on the server after you opened it. Your draft was not written. Reload or resolve it in full CoCalc.",
        );
      } else {
        setError(err instanceof Error ? err.message : `${err}`);
      }
    } finally {
      setSaving(false);
    }
  };
  useEditCheckpoint({
    active:
      editing &&
      dirty &&
      !saving &&
      !conflict &&
      !externalChanged &&
      !mergeNeedsReview &&
      !readOnly,
    revision: editRevision,
    save,
  });

  return (
    <div>
      <div className="ul-file-view-header">
        <div className="ul-toolbar">
          {!readOnly ? (
            <button
              className="ul-button ul-button-secondary"
              onClick={() => {
                if (editing) {
                  setDraft(editorRef.current?.getValue() ?? draft);
                  setEditing(false);
                } else {
                  setEditing(true);
                }
              }}
              type="button"
            >
              {editing ? "Preview" : "Edit"}
            </button>
          ) : null}
          {editing ? (
            <>
              <button
                className="ul-button"
                disabled={!dirty || saving || conflict || externalChanged}
                onClick={() => void save()}
                type="button"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                className="ul-button ul-button-secondary"
                disabled={!dirty || saving}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm("Revert your unsaved changes?")
                  ) {
                    editorRef.current?.replaceValue(base);
                    setDraft(base);
                    setDirty(false);
                    setConflict(false);
                    setMergeNeedsReview(false);
                    setError(undefined);
                  }
                }}
                type="button"
              >
                Revert
              </button>
            </>
          ) : null}
          <label className="ul-check-label">
            <input
              checked={wrap}
              onChange={(event) => setWrap(event.target.checked)}
              type="checkbox"
            />
            Wrap lines
          </label>
        </div>
        <span aria-live="polite" className="ul-editor-status">
          {editing ? cursor : language || "plain text"}
          {dirty ? " · unsaved" : ""}
        </span>
      </div>
      {readOnly ? (
        <InlineAlert kind="info">
          This file is read-only in Essential CoCalc because you are a viewer or
          it exceeds the 2 MiB editing limit.
        </InlineAlert>
      ) : null}
      {notice ? <InlineAlert>{notice}</InlineAlert> : null}
      {error ? <InlineAlert kind="error">{error}</InlineAlert> : null}
      {editing ? (
        <>
          <Suspense fallback={<LoadingState label="Loading code editor" />}>
            <LazyCodeMirrorEditor
              ariaLabel={`Edit ${path.split("/").pop() || "file"}`}
              initialValue={draft}
              key={path}
              language={language}
              onDirtyChange={(nextDirty) => {
                setDirty(nextDirty);
                setMergeNeedsReview(false);
                setNotice(undefined);
              }}
              onCursorChange={setCursor}
              onChange={() => setEditRevision((value) => value + 1)}
              onLanguageError={setError}
              onSave={() => void save()}
              path={path}
              readOnly={saving}
              ref={editorRef}
              wrap={wrap}
            />
          </Suspense>
          <p className="ul-editor-help">
            Search with Ctrl-F or Command-F. Press Escape, then Tab, to move
            focus out of the editor.
          </p>
        </>
      ) : language === "markdown" ? (
        <Suspense fallback={<LoadingState label="Rendering Markdown" />}>
          <LazyMarkdownView source={draft} />
        </Suspense>
      ) : (
        <HighlightedCode contents={draft} language={language} wrap={wrap} />
      )}
    </div>
  );
}

export default forwardRef(CodeView);
