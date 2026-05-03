/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";

const STORAGE_KEY = "agent-chat-font-size-v1";

export const AGENT_CHAT_FONT_MIN = 11;
export const AGENT_CHAT_FONT_MAX = 24;
export const AGENT_CHAT_FONT_STEP = 1;

function clampFontSize(value: number): number {
  const rounded = Math.round(value);
  return Math.max(AGENT_CHAT_FONT_MIN, Math.min(AGENT_CHAT_FONT_MAX, rounded));
}

function parseFontSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampFontSize(value);
  }
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return clampFontSize(parsed);
    }
  }
  return undefined;
}

function setPageFontSize(value: number): void {
  redux.getStore("page")?.setState({
    agent_chat_font_size: value,
  });
}

export function readAgentChatFontSize(fallback = 13): number {
  const stored = parseFontSize(get_local_storage(STORAGE_KEY));
  return stored ?? clampFontSize(fallback);
}

export function writeAgentChatFontSize(value: number): number {
  const next = clampFontSize(value);
  set_local_storage(STORAGE_KEY, String(next));
  setPageFontSize(next);
  return next;
}

export function useAgentChatFontSize(fallback = 13) {
  const pageFontSize = useTypedRedux("page", "agent_chat_font_size");
  const fontSize =
    parseFontSize(pageFontSize) ?? readAgentChatFontSize(fallback);

  const setFontSize = useCallback((value: number) => {
    return writeAgentChatFontSize(value);
  }, []);

  const increaseFontSize = useCallback(() => {
    setFontSize(fontSize + AGENT_CHAT_FONT_STEP);
  }, [fontSize, setFontSize]);

  const decreaseFontSize = useCallback(() => {
    setFontSize(fontSize - AGENT_CHAT_FONT_STEP);
  }, [fontSize, setFontSize]);

  return {
    fontSize,
    setFontSize,
    increaseFontSize,
    decreaseFontSize,
    canIncreaseFontSize: fontSize < AGENT_CHAT_FONT_MAX,
    canDecreaseFontSize: fontSize > AGENT_CHAT_FONT_MIN,
  };
}
