/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Alert } from "antd";
import { useEffect, useMemo, useRef } from "react";
import { CodeView } from "@pierre/diffs/react";
import type { CodeViewItem } from "@pierre/diffs";
import { useAppearance } from "@cocalc/frontend/appearance/use-appearance";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import {
  getEventPath,
  isEditableOrKeyboardInteractiveTarget,
} from "@cocalc/frontend/keyboard/boundary";
import {
  matchGitDrawerScrollCommand,
  runGitDrawerScrollCommand,
} from "@cocalc/frontend/chat/git-commit/drawer-scroll";
import { DiffHighlightingProvider } from "./highlighting-provider";
import { parsePreviewSource } from "./pierre-model";
import type { DiffPreviewSource } from "./preview-types";
import { diffFontStyle, diffLineHeight } from "./font-metrics";
import {
  setDiffViewPreference,
  useDiffViewPreferences,
} from "./view-preferences";

export interface DocumentDiffProps {
  before: string;
  after: string;
  path: string;
  label: string;
  fontSize: number;
}

export default function DocumentDiff(props: DocumentDiffProps) {
  const source = useMemo<DiffPreviewSource>(
    () => ({
      kind: "documents",
      before: props.before,
      after: props.after,
      path: props.path,
      label: props.label,
    }),
    [props.before, props.after, props.path, props.label],
  );
  return <ReadOnlyDiff source={source} fontSize={props.fontSize} />;
}

export function ReadOnlyDiff(props: {
  source: DiffPreviewSource;
  fontSize: number;
}) {
  return (
    <DiffHighlightingProvider>
      <DocumentDiffContent {...props} />
    </DiffHighlightingProvider>
  );
}

function DocumentDiffContent({
  source,
  fontSize,
}: {
  source: DiffPreviewSource;
  fontSize: number;
}) {
  const { label } = source;
  const { resolved } = useAppearance();
  const { split, wrap } = useDiffViewPreferences();
  const viewport = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => {
    try {
      const texts =
        source.kind === "documents"
          ? [source.before, source.after]
          : [source.patch];
      // Refuse oversized sources instead of presenting a truncated document as
      // complete. Individual historical versions remain available separately.
      if (
        texts.reduce((sum, text) => sum + text.length, 0) > 4 * 1024 * 1024 ||
        texts.reduce(
          (sum, text) => sum + new TextEncoder().encode(text).length,
          0,
        ) >
          4 * 1024 * 1024
      ) {
        throw Error(
          "Text comparison exceeds 4 MB. Choose a smaller comparison or view the versions separately.",
        );
      }
      let lines = 2;
      for (const text of texts) {
        for (let index = 0; index < text.length; index++) {
          if (text.charCodeAt(index) === 10 && ++lines > 100_000)
            throw Error(
              "Text comparison exceeds 100,000 lines. Choose a smaller comparison or view the versions separately.",
            );
        }
      }
      const files = parsePreviewSource(source);
      return { files, error: "" };
    } catch (error) {
      return { files: [], error: String(error) };
    }
  }, [source]);
  const generation = useRef({ parsed, version: 0 });
  if (generation.current.parsed !== parsed) {
    generation.current = { parsed, version: generation.current.version + 1 };
  }
  const identical =
    source.kind === "documents" && source.before === source.after;
  const items: CodeViewItem<undefined>[] =
    identical && !parsed.error
      ? [
          {
            id: JSON.stringify([source.path, "identical"]),
            type: "file",
            file: { name: source.path, contents: source.after },
            version: generation.current.version,
          },
        ]
      : parsed.files.map((fileDiff) => ({
          id: JSON.stringify([fileDiff.prevName, fileDiff.name]),
          type: "diff",
          fileDiff,
          version: generation.current.version,
        }));
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    node.tabIndex = 0;
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", label);
    node.setAttribute(
      "aria-keyshortcuts",
      "Space Shift+Space PageDown PageUp ArrowDown ArrowUp Home",
    );
  }, [label, parsed.error]);
  return (
    <section
      aria-label="Historical text comparison"
      onKeyDown={(event) => {
        if (getEventPath(event).some(isEditableOrKeyboardInteractiveTarget))
          return;
        const command = matchGitDrawerScrollCommand(event);
        if (!command || !viewport.current) return;
        event.preventDefault();
        event.stopPropagation();
        runGitDrawerScrollCommand(viewport.current, command);
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: "1 1 0",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        color: UI_COLORS.text,
        background: UI_COLORS.surface,
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          padding: 4,
          flexShrink: 0,
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={split}
            onChange={(event) =>
              setDiffViewPreference("split", event.target.checked)
            }
          />{" "}
          Side by side
        </label>
        <label>
          <input
            type="checkbox"
            checked={wrap}
            onChange={(event) =>
              setDiffViewPreference("wrap", event.target.checked)
            }
          />{" "}
          Wrap lines
        </label>
      </div>
      {identical && !parsed.error && (
        <div role="status">Identical versions</div>
      )}
      {parsed.error ? (
        <Alert
          type="error"
          title="Unable to render text comparison"
          description={parsed.error}
        />
      ) : (
        <CodeView
          containerRef={viewport}
          items={items}
          options={{
            diffStyle: split ? "split" : "unified",
            overflow: wrap ? "wrap" : "scroll",
            lineDiffType: "word",
            expandUnchanged: source.kind === "documents",
            stickyHeaders: true,
            itemMetrics: { lineHeight: diffLineHeight(fontSize) },
            theme: { light: "github-light", dark: "github-dark" },
            themeType: resolved,
          }}
          style={{
            flex: "1 1 0",
            minHeight: 0,
            minWidth: 0,
            width: "100%",
            maxWidth: "100%",
            overflow: "auto",
            ...diffFontStyle(fontSize),
          }}
        />
      )}
    </section>
  );
}
