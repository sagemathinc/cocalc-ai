/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Renders an agent turn's timeline rows. In the chat log each row is its own
// row of the log's virtualized list (`TurnActivityListRow`), so a turn with
// thousands of rows only mounts the rows near the viewport.

import { Button, message as antdMessage } from "antd";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { memo, useRef, type CSSProperties } from "react";
import type { InlineCodeLink } from "@cocalc/chat";
import { copyTextToClipboard } from "@cocalc/frontend/components/copy-to-clipboard-util";
import StaticMarkdown from "@cocalc/frontend/editors/slate/static-markdown";
import type { ChatActions } from "./actions";
import { ArtifactPublicationCard } from "./artifacts";
import { useChatEmbeddingOptions } from "./embedding-options";
import {
  parseGitCommitLink,
  resolveMessageGitBrowserRequest,
} from "./git-commit-links";
import { resolveGitTurnDirectory } from "./git-turn-context";
import { AgentMessageFileContext } from "./message-file-context";
import { openProjectFileResult } from "./open-result";
import { projectFileTargetFromHref } from "./project-file-target";
import ContextualReply, { quoteMarkdown } from "./contextual-reply";
import { guidanceMarkdown } from "./message-state";
import { useFedTurnRow } from "./turn-activity";
import { MAX_RENDERED_TEXT_CHARS } from "./paged-text";
import type { TurnTimelineRow } from "./turn-timeline";
import "./turn-activity-timeline.css";

export interface TurnTimelineContext {
  actions?: ChatActions;
  projectId?: string;
  path?: string;
  threadId?: string;
  messageId: string;
  readOnly?: boolean;
  fontSize?: number;
  markdownStyle?: CSSProperties;
  className?: string;
  editorTheme?: string | null;
  highlightQuery?: string;
  inlineCodeLinks?: InlineCodeLink[];
  inlineCodeProjectRoot?: string;
  // Display-only decoration of agent Markdown, e.g. linking commit hashes.
  formatAgentMarkdown?: (markdown: string) => string;
}

// All rows of a turn, unvirtualized, for views without a virtualized list.
export function TurnActivityTimeline({
  rows,
  context,
}: {
  rows: TurnTimelineRow[];
  context: TurnTimelineContext;
}) {
  return (
    <div className="cocalc-turn-timeline">
      {rows.map((row) => (
        <TurnTimelineRowView key={row.id} row={row} context={context} />
      ))}
    </div>
  );
}

export function sameRow(a: TurnTimelineRow, b: TurnTimelineRow): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind === "artifact" || b.kind === "artifact") {
    return (
      a.kind === "artifact" &&
      b.kind === "artifact" &&
      a.publication.operation_id === b.publication.operation_id
    );
  }
  return (
    a.text === b.text &&
    (a.kind !== "guidance" || b.kind !== "guidance" || a.state === b.state)
  );
}

// Finished rows never re-render while the turn streams: only the last row's
// text changes.
const TurnTimelineRowView = memo(
  function TurnTimelineRowView({
    row,
    context,
  }: {
    row: TurnTimelineRow;
    context: TurnTimelineContext;
  }) {
    if (row.kind === "artifact") {
      if (context.actions == null) return null;
      return (
        <div className="cocalc-turn-row" data-turn-row={row.id}>
          <ArtifactPublicationCard
            actions={context.actions}
            publication={row.publication}
          />
        </div>
      );
    }
    const markdown =
      row.kind === "guidance"
        ? guidanceMarkdown(row.text, row.state)
        : row.text;
    // Optional decorations (e.g. commit links) must not undo the row's bound
    // on the text given to the parser.
    const formatted =
      row.kind === "agent" && context.formatAgentMarkdown
        ? context.formatAgentMarkdown(markdown)
        : markdown;
    const displayed =
      formatted.length <= MAX_RENDERED_TEXT_CHARS ? formatted : markdown;
    return (
      <TimelineMarkdownRow
        rowId={row.id}
        label={row.kind === "guidance" ? "guidance" : "agent output"}
        quoted={row.text}
        markdown={markdown}
        displayed={displayed}
        context={context}
      />
    );
  },
  (prev, next) => prev.context === next.context && sameRow(prev.row, next.row),
);

function TimelineMarkdownRow({
  rowId,
  label,
  quoted,
  markdown,
  displayed,
  context,
}: {
  rowId: string;
  label: string;
  // Markdown staged by Quote: guidance without its presentation fence.
  quoted: string;
  // Markdown copied by Copy.
  markdown: string;
  displayed: string;
  context: TurnTimelineContext;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const canQuote =
    !context.readOnly &&
    !!context.threadId &&
    !!context.actions?.appendToComposerDraft;
  const quote = () => {
    if (!canQuote) return;
    context.actions!.appendToComposerDraft!({
      threadKey: context.threadId!,
      text: quoteMarkdown(quoted.trim()),
    });
  };
  const copy = async () => {
    const ok = await copyTextToClipboard({
      text: markdown,
      markdown: true,
      html: bodyRef.current?.innerHTML,
    });
    if (ok) antdMessage.success("Copied");
    else antdMessage.error("Unable to copy");
  };
  return (
    <div className="cocalc-turn-row" data-turn-row={rowId}>
      <div
        className="cocalc-turn-row-actions"
        role="group"
        aria-label={`Actions for this ${label}`}
      >
        {canQuote ? (
          <Button size="small" type="text" onClick={quote}>
            Quote block
          </Button>
        ) : null}
        <Button size="small" type="text" onClick={() => void copy()}>
          Copy block
        </Button>
      </div>
      <ContextualReply
        actions={context.actions}
        projectId={context.projectId ?? ""}
        path={context.path ?? ""}
        disabled={
          context.readOnly ||
          !context.projectId ||
          !context.path ||
          !context.threadId
        }
        source={{
          kind: "message",
          id: context.messageId,
          thread_id: context.threadId ?? "",
          title: "Agent activity",
        }}
      >
        <div ref={bodyRef} data-chat-selectable-message="true">
          <StaticMarkdown
            value={displayed}
            className={context.className}
            style={context.markdownStyle}
            editorTheme={context.editorTheme}
            highlightQuery={context.highlightQuery}
            inlineCodeLinks={context.inlineCodeLinks}
            inlineCodeProjectRoot={context.inlineCodeProjectRoot}
          />
        </div>
      </ContextualReply>
    </div>
  );
}

export interface TurnListRowContext extends TurnTimelineContext {
  messageDate: number;
  // The turn's current log events (read on demand to keep contexts stable).
  getEvents?: () => readonly unknown[] | null | undefined;
  onOpenGitBrowser?: (request: {
    threadKey: string;
    cwdOverride?: string;
    commitHash: string;
  }) => void;
}

const PANEL_BORDER = `1px solid ${UI_COLORS.border}`;

// One row of a turn's activity as a row of the chat list. Consecutive rows
// draw one bordered "Agent activity" panel between the prompt and the
// agent's message.
export const TurnActivityListRow = memo(
  function TurnActivityListRow({
    row: listedRow,
    first,
    last,
    context,
  }: {
    row: TurnTimelineRow;
    first: boolean;
    last: boolean;
    context: TurnListRowContext;
  }) {
    const row = useFedTurnRow(context.messageId, listedRow);
    const embeddingOptions = useChatEmbeddingOptions();
    const openLink = (event: React.MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      const href = anchor?.getAttribute("href");
      const commitHash = parseGitCommitLink(href);
      if (commitHash && context.onOpenGitBrowser) {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          const cwdOverride = await resolveGitTurnDirectory({
            events: context.getEvents?.(),
            fallback: context.inlineCodeProjectRoot,
          });
          context.onOpenGitBrowser?.(
            resolveMessageGitBrowserRequest({
              messageThreadId: context.threadId,
              date: context.messageDate,
              activityBasePath: cwdOverride,
              renderedMessageValue: "",
              commitHash,
            }),
          );
        })();
        return;
      }
      const actions = context.actions;
      if (!embeddingOptions.openFilesInWorkbench || !actions) return;
      // Human guidance keeps chat-relative navigation.
      if (anchor?.closest(".cocalc-slate-guidance")) return;
      const file = projectFileTargetFromHref({
        href,
        projectId: context.projectId,
        basePath: context.inlineCodeProjectRoot,
      });
      if (!file) return;
      event.preventDefault();
      event.stopPropagation();
      openProjectFileResult(actions, {
        kind: "file",
        ...file,
        threadId: context.threadId,
      });
    };
    return (
      <div
        onClickCapture={openLink}
        style={{
          borderLeft: PANEL_BORDER,
          borderRight: PANEL_BORDER,
          borderTop: first ? PANEL_BORDER : undefined,
          borderBottom: last ? PANEL_BORDER : undefined,
          borderTopLeftRadius: first ? 12 : undefined,
          borderTopRightRadius: first ? 12 : undefined,
          borderBottomLeftRadius: last ? 12 : undefined,
          borderBottomRightRadius: last ? 12 : undefined,
          padding: `${first ? 10 : 0}px 12px ${last ? 4 : 0}px`,
          marginTop: first ? 10 : 0,
          marginBottom: last ? 4 : 0,
          fontSize: context.fontSize,
        }}
      >
        {first ? (
          <div
            style={{
              marginBottom: 10,
              fontSize: `${Math.max((context.fontSize ?? 14) - 2, 11)}px`,
              fontWeight: 600,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: UI_COLORS.secondary,
            }}
          >
            Agent activity
          </div>
        ) : null}
        <AgentMessageFileContext
          projectId={context.projectId}
          path={context.path}
          directory={context.inlineCodeProjectRoot}
        >
          <TurnTimelineRowView row={row} context={context} />
        </AgentMessageFileContext>
      </div>
    );
  },
  (prev, next) =>
    prev.context === next.context &&
    prev.first === next.first &&
    prev.last === next.last &&
    sameRow(prev.row, next.row),
);
