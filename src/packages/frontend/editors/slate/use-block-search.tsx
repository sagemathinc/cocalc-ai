/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Popconfirm } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { delay } from "awaiting";
import { IS_MACOS } from "./keyboard/register";
import { IS_TOUCH } from "@cocalc/frontend/feature";
import type { SearchHook } from "./search";
import { createSearchDecorate } from "./search/decorate";
import {
  findNextMatchIndex,
  findPreviousMatchIndex,
} from "./block-markdown-utils";

interface Options {
  getFullMarkdown: () => string;
  applyBlocksFromValue: (markdown: string) => void;
  selectGlobalRange: (startIndex: number, endIndex: number) => void;
  getSelectionGlobalRange: () => { start: number; end: number } | null;
}

export function useBlockSearch(options: Options): {
  searchHook: SearchHook;
  searchDecorate: ([node, path]) => { anchor: any; focus: any; search: true }[];
  searchQuery: string;
} {
  const {
    getFullMarkdown,
    applyBlocksFromValue,
    selectGlobalRange,
    getSelectionGlobalRange,
  } = options;
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [replaceQuery, setReplaceQuery] = useState<string>("");
  const searchInputRef = useRef<any>(null);
  const lastMatchIndexRef = useRef<number | null>(null);

  useEffect(() => {
    lastMatchIndexRef.current = null;
    if (!searchQuery.trim()) {
      setReplaceQuery("");
    }
  }, [searchQuery]);

  const searchDecorate = useMemo(
    () => createSearchDecorate(searchQuery),
    [searchQuery],
  );

  const findNextMatch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const fullMarkdown = getFullMarkdown();
    const selection = getSelectionGlobalRange();
    const idx = findNextMatchIndex(
      fullMarkdown,
      query,
      selection,
      lastMatchIndexRef.current,
    );
    if (idx == null) return;
    lastMatchIndexRef.current = idx;
    selectGlobalRange(idx, idx + query.length);
  }, [getFullMarkdown, getSelectionGlobalRange, searchQuery, selectGlobalRange]);

  const findPreviousMatch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const fullMarkdown = getFullMarkdown();
    const selection = getSelectionGlobalRange();
    const idx = findPreviousMatchIndex(
      fullMarkdown,
      query,
      selection,
      lastMatchIndexRef.current,
    );
    if (idx == null) return;
    lastMatchIndexRef.current = idx;
    selectGlobalRange(idx, idx + query.length);
  }, [getFullMarkdown, getSelectionGlobalRange, searchQuery, selectGlobalRange]);

  const replaceOneMatch = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const replacement = replaceQuery;
    if (!replacement.trim()) return;
    const fullMarkdown = getFullMarkdown();
    const lower = fullMarkdown.toLowerCase();
    const q = query.toLowerCase();
    const selection = getSelectionGlobalRange();
    let idx: number | null = null;
    if (
      selection &&
      selection.end - selection.start === q.length &&
      lower.slice(selection.start, selection.start + q.length) === q
    ) {
      idx = selection.start;
    } else {
      const from = selection?.end ?? 0;
      idx = lower.indexOf(q, from);
      if (idx === -1 && from > 0) {
        idx = lower.indexOf(q, 0);
      }
      if (idx === -1) idx = null;
    }
    if (idx == null) return;
    const nextMarkdown =
      fullMarkdown.slice(0, idx) +
      replacement +
      fullMarkdown.slice(idx + q.length);
    applyBlocksFromValue(nextMarkdown);
    lastMatchIndexRef.current = idx;
    selectGlobalRange(idx, idx + replacement.length);
  }, [
    applyBlocksFromValue,
    getFullMarkdown,
    getSelectionGlobalRange,
    replaceQuery,
    searchQuery,
    selectGlobalRange,
  ]);

  const replaceAllMatches = useCallback(() => {
    const query = searchQuery.trim();
    if (!query) return;
    const replacement = replaceQuery;
    if (!replacement.trim()) return;
    const fullMarkdown = getFullMarkdown();
    const lower = fullMarkdown.toLowerCase();
    const q = query.toLowerCase();
    let idx = lower.indexOf(q);
    if (idx === -1) return;
    let out = "";
    let last = 0;
    let firstMatch: number | null = null;
    while (idx !== -1) {
      if (firstMatch == null) firstMatch = idx;
      out += fullMarkdown.slice(last, idx) + replacement;
      last = idx + q.length;
      idx = lower.indexOf(q, last);
    }
    out += fullMarkdown.slice(last);
    applyBlocksFromValue(out);
    if (firstMatch != null) {
      lastMatchIndexRef.current = firstMatch;
      selectGlobalRange(firstMatch, firstMatch + replacement.length);
    }
  }, [
    applyBlocksFromValue,
    getFullMarkdown,
    replaceQuery,
    searchQuery,
    selectGlobalRange,
  ]);

  const searchHook = useMemo<SearchHook>(() => {
    const keyboardMessage = `Find Next (${IS_MACOS ? "⌘" : "ctrl"}-G) and Prev (Shift-${IS_MACOS ? "⌘" : "ctrl"}-G).`;
    const Search = (
      <div
        style={{
          border: 0,
          width: "100%",
          position: "relative",
        }}
      >
        <div style={{ display: "flex" }}>
          <Input
            ref={searchInputRef}
            allowClear
            size="small"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ border: 0, flex: 1 }}
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey) {
                if (event.key === "f") {
                  event.preventDefault();
                  return;
                }
                if (event.key === "g") {
                  event.preventDefault();
                  if (event.shiftKey) {
                    findPreviousMatch();
                  } else {
                    findNextMatch();
                  }
                  return;
                }
              }
              if (event.key === "Enter") {
                event.preventDefault();
                findNextMatch();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSearchQuery("");
                searchInputRef.current?.blur();
                return;
              }
            }}
          />
          {searchQuery.trim() && (
            <div style={{ height: 23 }}>
              <Button
                shape="round"
                type="text"
                size="small"
                style={{ padding: "0 5px" }}
                onClick={findPreviousMatch}
              >
                <Icon name="chevron-up" />
              </Button>{" "}
              <Button
                shape="round"
                type="text"
                size="small"
                style={{ padding: "0 5px" }}
                onClick={findNextMatch}
              >
                <Icon name="chevron-down" />
              </Button>
            </div>
          )}
        </div>
        {searchQuery.trim() && (
          <div
            style={{
              position: "absolute",
              opacity: 0.95,
              marginTop: "2px",
              zIndex: 1,
              background: "white",
              width: "100%",
              color: "rgb(102,102,102)",
              borderLeft: "1px solid lightgrey",
              borderBottom: "1px solid lightgrey",
              boxShadow: "-3px 5px 2px lightgrey",
            }}
          >
            <div style={{ display: "flex", gap: "6px", padding: "4px 6px" }}>
              <Input
                size="small"
                placeholder="Replace with..."
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
              />
              <Button
                size="small"
                type="text"
                disabled={!replaceQuery.trim()}
                onClick={replaceOneMatch}
              >
                Replace
              </Button>
              <Popconfirm
                placement="bottomRight"
                title={`Replace all instances of '${searchQuery}'?`}
                onConfirm={replaceAllMatches}
                okText="Yes, replace all"
                cancelText="Cancel"
                disabled={!replaceQuery.trim()}
              >
                <Button size="small" type="text" disabled={!replaceQuery.trim()}>
                  Replace all
                </Button>
              </Popconfirm>
            </div>
            {!IS_TOUCH && (
              <div style={{ marginLeft: "7px" }}>{keyboardMessage}</div>
            )}
          </div>
        )}
      </div>
    );
    return {
      decorate: searchDecorate,
      Search,
      search: searchQuery,
      previous: findPreviousMatch,
      next: findNextMatch,
      focus: async (search) => {
        if (search?.trim()) {
          setSearchQuery(search);
          await delay(0);
        }
        searchInputRef.current?.focus({ cursor: "all" });
      },
    };
  }, [
    findNextMatch,
    findPreviousMatch,
    replaceAllMatches,
    replaceOneMatch,
    replaceQuery,
    searchDecorate,
    searchQuery,
  ]);

  return { searchHook, searchDecorate, searchQuery };
}
