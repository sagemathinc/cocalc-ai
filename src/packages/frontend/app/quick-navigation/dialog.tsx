/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Button, Input, Modal, Space, Typography } from "antd";
import type { InputRef } from "antd";
import { FormattedMessage, useIntl } from "react-intl";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { joinUrlPath } from "@cocalc/util/url-path";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import "./quick-navigation.css";
import { NavigationConfiguration } from "./configuration";
import type { Candidate, Destination, Editor } from "./model";
import { FramePreview, numberedFrame } from "./preview";
import { HELP_SLUG } from "./navigate";
import { searchCandidates } from "./search";
import type { Span } from "./search";

export function Highlight({ text, spans }: { text: string; spans: Span[] }) {
  const marked = new Set<number>();
  for (const [start, end] of spans)
    for (let i = start; i < end; i++) marked.add(i);
  const parts: ReactNode[] = [];
  for (let start = 0; start < text.length; ) {
    const bold = marked.has(start);
    let end = start + 1;
    while (end < text.length && marked.has(end) === bold) end++;
    parts.push(
      bold ? (
        <strong key={start}>{text.slice(start, end)}</strong>
      ) : (
        text.slice(start, end)
      ),
    );
    start = end;
  }
  return <>{parts}</>;
}

const LIST_HEIGHT = "min(52dvh, 420px)";

export function NavigationDialog({
  items,
  currentEditor,
  projectId,
  onClosed,
}: {
  items: Candidate[];
  currentEditor?: Editor;
  projectId?: string;
  onClosed: (destination?: Destination) => void;
}) {
  const intl = useIntl();
  const id = useId();
  const input = useRef<InputRef>(null);
  const preview = useRef<HTMLDivElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const help = useRef<HTMLButtonElement | HTMLAnchorElement>(null);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [previewFocused, setPreviewFocused] = useState(false);
  const [configure, setConfigure] = useState(false);
  const destination = useRef<Destination | undefined>(undefined);
  const matches = useMemo(() => searchCandidates(items, query), [items, query]);
  const results = matches.slice(0, 80);
  const selectedIndex = Math.max(
    0,
    results.findIndex((result) => result.item.id === selectedId),
  );
  const selected = results[selectedIndex]?.item;
  const editor =
    !query && selectedId == null ? currentEditor : selected?.editor;
  const hasFrames = !!editor?.frames.length;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (!hasFrames && previewFocused) input.current?.focus();
  }, [hasFrames, previewFocused]);
  // The list has one entry per file; frames are chosen in the preview. The
  // highlighted frame is the one Enter would land on.
  const frameId = editor?.activeId;
  useEffect(() => {
    document
      .getElementById(`${id}-result-${selectedIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [id, selectedIndex, selected?.id]);
  const fileName = editor?.path.split("/").pop() || editor?.path;
  const frameLabel = editor?.frames.find(
    (frame) => frame.id === frameId,
  )?.label;
  // One context-sensitive hint: it follows keyboard focus (search or frame
  // preview) and what the selection offers.
  const hint = previewFocused
    ? frameLabel
      ? intl.formatMessage(
          {
            id: "quick-nav.hint.preview",
            defaultMessage:
              "1–9 open a frame · 0 chat · Enter opens “{frame}” · Shift+Tab back to search",
          },
          { file: fileName, frame: frameLabel },
        )
      : intl.formatMessage(
          {
            id: "quick-nav.hint.preview-no-frame",
            defaultMessage:
              "1–9 open a frame · 0 chat · Shift+Tab back to search",
          },
          { file: fileName },
        )
    : hasFrames && !query
      ? intl.formatMessage(
          {
            id: "quick-nav.hint.search-frames-empty",
            defaultMessage:
              "Enter opens {file} · 1–9 open a frame · 0 chat · Space first to search numbers",
          },
          { file: fileName },
        )
      : hasFrames
        ? intl.formatMessage(
            {
              id: "quick-nav.hint.search-frames",
              defaultMessage:
                "↑↓ select · Enter opens {file} · Tab: frame selector",
            },
            { file: fileName },
          )
        : intl.formatMessage({
            id: "quick-nav.hint.search",
            defaultMessage: "↑↓ select · Enter opens the selected result",
          });

  function close(target?: Destination) {
    destination.current = target;
    setOpen(false);
  }
  function frameTarget(frame: string): Destination | undefined {
    return editor
      ? {
          kind: "file",
          projectId: editor.projectId,
          path: editor.path,
          frameId: frame,
        }
      : undefined;
  }
  // 1–9 choose a frame of the previewed editor; 0 goes to its chat, opening
  // the side chat when the layout has no chat frame yet.
  function digitTarget(digit: string): Destination | undefined {
    if (!editor?.frames.length) return;
    const frame = numberedFrame(editor, digit);
    if (frame) return frameTarget(frame.id);
    if (digit === "0")
      return {
        kind: "file",
        projectId: editor.projectId,
        path: editor.path,
        chat: true,
      };
  }
  function change(value: string) {
    setQuery(value);
    setSelectedId(undefined);
  }

  // Escape closes from anywhere, and Tab cycles only through the dialog's own
  // controls: search, frame preview, configure, help. The modal's focus lock
  // only reacts to focusin, so a Tab that leaves the last element for the
  // browser chrome would otherwise escape the dialog.
  useEffect(() => {
    if (!open || configure) return;
    const handle = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key !== "Escape" && event.key !== "Tab") return;
      const dialog = input.current?.input?.closest('[role="dialog"]');
      const active = document.activeElement;
      const inside =
        active == null ||
        active === document.body ||
        (dialog?.contains(active) ?? false);
      if (!inside) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        close();
        return;
      }
      const candidates: (HTMLElement | null | undefined)[] = [
        input.current?.input,
        preview.current,
        gear.current,
        help.current,
      ];
      const targets = candidates.filter((el): el is HTMLElement => el != null);
      if (!targets.length) return;
      const index = targets.findIndex(
        (el) => el === active || (active != null && el.contains(active)),
      );
      const delta = event.shiftKey ? -1 : 1;
      const next =
        index < 0
          ? delta > 0
            ? 0
            : targets.length - 1
          : (index + delta + targets.length) % targets.length;
      targets[next].focus();
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [open, configure]);

  function searchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (!query && hasFrames && /^[0-9]$/.test(event.key)) {
      // Digits are commands only in an empty input. A leading space keeps
      // numeric queries in search mode; pasted text is always a search.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      const target = digitTarget(event.key);
      if (target) close(target);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!results.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedId(
        results[(selectedIndex + delta + results.length) % results.length].item
          .id,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = selected?.destination;
      if (target) close(target);
    }
  }
  function previewKey(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.nativeEvent.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      if (event.repeat) return;
      const target = digitTarget(event.key);
      if (target) close(target);
    } else if (
      event.key === "Enter" &&
      event.target === preview.current &&
      frameId
    ) {
      event.preventDefault();
      close(frameTarget(frameId));
    }
  }
  return (
    <>
      <Modal
        title={
          <div
            role="group"
            aria-label={intl.formatMessage({
              id: "quick-nav.title",
              defaultMessage: "Quick Navigation",
            })}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              paddingRight: 28,
              flexWrap: "wrap",
            }}
          >
            <span style={{ flex: 1 }}>
              <Icon name="bolt" />{" "}
              <FormattedMessage
                id="quick-nav.title"
                defaultMessage="Quick Navigation"
              />
            </span>
            <Space>
              <Button
                ref={gear}
                type="text"
                size="small"
                aria-label={intl.formatMessage({
                  id: "quick-nav.configure-title",
                  defaultMessage: "Configure Quick Navigation",
                })}
                aria-haspopup="dialog"
                icon={<Icon name="gear" />}
                onClick={() => setConfigure(true)}
              >
                <FormattedMessage
                  id="quick-nav.configure"
                  defaultMessage="Configure"
                />
              </Button>
              <Button
                ref={help}
                type="text"
                size="small"
                icon={<Icon name="question-circle" />}
                href={joinUrlPath(appBasePath, "docs", HELP_SLUG)}
                onClick={(event) => {
                  if (
                    event.button ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  close({ kind: "docs", projectId });
                }}
              >
                <FormattedMessage id="quick-nav.help" defaultMessage="Help" />
              </Button>
            </Space>
          </div>
        }
        open={open}
        centered
        width={840}
        footer={null}
        focusable={{ focusTriggerAfterClose: false }}
        afterOpenChange={(visible) => {
          // The modal focuses its own panel when the open animation ends.
          // Move that to the search input, but leave a control the user
          // already tabbed to alone.
          if (!visible) return;
          const active = document.activeElement;
          const dialog = input.current?.input?.closest('[role="dialog"]');
          const onControl =
            active instanceof HTMLElement &&
            active !== dialog &&
            !!dialog?.contains(active) &&
            active.tabIndex >= 0;
          if (!onControl) input.current?.focus();
        }}
        afterClose={() => onClosed(destination.current)}
        onCancel={() => close()}
        styles={{
          body: { maxHeight: "75dvh", overflowY: "auto" },
        }}
      >
        <KeyboardBoundary boundary="quick-navigation">
          <div>
            <label htmlFor={`${id}-search`}>
              <FormattedMessage
                id="quick-nav.search-label"
                defaultMessage="Search projects, files, frames, and settings"
              />
            </label>
            <Input
              id={`${id}-search`}
              ref={input}
              autoFocus
              role="combobox"
              value={query}
              aria-describedby={`${id}-digit-hint`}
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={`${id}-results`}
              aria-activedescendant={
                results.length ? `${id}-result-${selectedIndex}` : undefined
              }
              onChange={(event) => change(event.target.value)}
              onKeyDown={searchKey}
            />
            <Typography.Text
              id={`${id}-digit-hint`}
              type="secondary"
              role="status"
              aria-live="polite"
              title={hint}
              style={{
                display: "block",
                fontSize: "0.85em",
                marginTop: 4,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {hint}
            </Typography.Text>
          </div>
          <div
            data-testid="quick-nav-columns"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 2fr) minmax(0, 1fr)",
              alignItems: "start",
              gap: 12,
              margin: "12px 0",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                height: LIST_HEIGHT,
                minWidth: 0,
              }}
            >
              <Typography.Text
                type="secondary"
                role="status"
                aria-live="polite"
                style={{ display: "block", flexShrink: 0 }}
              >
                {intl.formatMessage(
                  {
                    id: "quick-nav.result-count",
                    defaultMessage: "{count} matches",
                  },
                  { count: matches.length },
                )}
              </Typography.Text>
              <ul
                id={`${id}-results`}
                role="listbox"
                aria-label="Navigation results"
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "8px 0",
                  flex: 1,
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {results.map((match, index) => (
                  <li key={match.item.id} role="presentation">
                    <button
                      type="button"
                      className="cc-quick-nav-result"
                      role="option"
                      aria-selected={index === selectedIndex}
                      id={`${id}-result-${index}`}
                      tabIndex={-1}
                      onClick={() => close(match.item.destination)}
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        padding: "8px 10px",
                        cursor: "pointer",
                        border: 0,
                        borderRadius: 4,
                        overflowWrap: "anywhere",
                      }}
                    >
                      <Highlight text={match.item.title} spans={match.title} />
                      <span
                        style={{
                          display: "block",
                          fontSize: "0.85em",
                          color: UI_COLORS.secondary,
                        }}
                      >
                        <Highlight
                          text={match.item.detail}
                          spans={match.detail}
                        />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div
              style={{
                // Span the whole row so the divider runs the full list height.
                alignSelf: "stretch",
                minWidth: 0,
                borderLeft: `1px solid ${UI_COLORS.border}`,
                paddingLeft: 12,
              }}
            >
              {editor && hasFrames ? (
                <div
                  ref={preview}
                  role="group"
                  tabIndex={0}
                  aria-label={`Frames in ${editor.path}`}
                  onKeyDown={previewKey}
                  onFocus={() => setPreviewFocused(true)}
                  onBlur={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    )
                      setPreviewFocused(false);
                  }}
                  style={{
                    padding: 8,
                    border: `2px solid ${previewFocused ? UI_COLORS.focus : UI_COLORS.border}`,
                    borderRadius: 6,
                  }}
                >
                  <Typography.Text
                    strong
                    style={{ display: "block", overflowWrap: "anywhere" }}
                  >
                    <FormattedMessage
                      id="quick-nav.preview-title"
                      defaultMessage="Frames of {file}"
                      values={{ file: fileName }}
                    />
                  </Typography.Text>
                  <Typography.Text
                    type="secondary"
                    style={{
                      display: "block",
                      fontSize: "0.85em",
                      marginBottom: 6,
                    }}
                  >
                    {previewFocused ? (
                      <FormattedMessage
                        id="quick-nav.preview-caption-focused"
                        defaultMessage="1–9 or Enter"
                      />
                    ) : (
                      <FormattedMessage
                        id="quick-nav.preview-caption"
                        defaultMessage="Tab, then 1–9"
                      />
                    )}
                  </Typography.Text>
                  <FramePreview
                    editor={editor}
                    selectedId={frameId}
                    onChoose={(frame) => close(frameTarget(frame))}
                  />
                </div>
              ) : null}
            </div>
          </div>
          <Typography.Text
            type="secondary"
            style={{ display: "block", fontSize: "0.85em" }}
          >
            <FormattedMessage
              id="quick-nav.footer"
              defaultMessage="Esc closes · Tab switches between search and frame selector"
            />
          </Typography.Text>
        </KeyboardBoundary>
      </Modal>
      <Modal
        title={
          <>
            <Icon name="bolt" />{" "}
            {intl.formatMessage({
              id: "quick-nav.configure-title",
              defaultMessage: "Configure Quick Navigation",
            })}
          </>
        }
        open={configure}
        centered
        width={520}
        onCancel={() => setConfigure(false)}
        footer={
          <Button onClick={() => setConfigure(false)}>
            <FormattedMessage
              id="quick-nav.configure-done"
              defaultMessage="Done"
            />
          </Button>
        }
      >
        <NavigationConfiguration />
      </Modal>
    </>
  );
}
