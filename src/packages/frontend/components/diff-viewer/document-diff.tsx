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
  return (
    <DiffHighlightingProvider>
      <DocumentDiffContent {...props} />
    </DiffHighlightingProvider>
  );
}

function DocumentDiffContent({
  before,
  after,
  path,
  label,
  fontSize,
}: DocumentDiffProps) {
  const { resolved } = useAppearance();
  const { split, wrap } = useDiffViewPreferences();
  const viewport = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => {
    try {
      // Refuse oversized sources instead of presenting a truncated document as
      // complete. The caller retains its original text renderer.
      if (
        before.length + after.length > 4 * 1024 * 1024 ||
        new TextEncoder().encode(before).length +
          new TextEncoder().encode(after).length >
          4 * 1024 * 1024
      ) {
        throw Error("Text comparison exceeds 4 MB; use the Classic renderer.");
      }
      let lines = 2;
      for (const text of [before, after]) {
        for (let index = 0; index < text.length; index++) {
          if (text.charCodeAt(index) === 10 && ++lines > 100_000)
            throw Error(
              "Text comparison exceeds 100,000 lines; use the Classic renderer.",
            );
        }
      }
      const files = parsePreviewSource({
        kind: "documents",
        before,
        after,
        path,
        label,
      });
      return { files, error: "" };
    } catch (error) {
      return { files: [], error: String(error) };
    }
  }, [before, after, path, label]);
  const generation = useRef({ parsed, version: 0 });
  if (generation.current.parsed !== parsed) {
    generation.current = { parsed, version: generation.current.version + 1 };
  }
  const items: CodeViewItem<undefined>[] = parsed.files.map((fileDiff) => ({
    id: path,
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
            expandUnchanged: true,
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
