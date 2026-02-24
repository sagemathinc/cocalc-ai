/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useCallback, useEffect, useState } from "react";
import { get_local_storage, set_local_storage } from "@cocalc/frontend/misc";

const STORAGE_KEY = "agent-chat-font-size-v1";
const CHANGE_EVENT = "cocalc:agent-chat-font-size";

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

export function readAgentChatFontSize(fallback = 13): number {
  const stored = parseFontSize(get_local_storage(STORAGE_KEY));
  return stored ?? clampFontSize(fallback);
}

export function writeAgentChatFontSize(value: number): number {
  const next = clampFontSize(value);
  set_local_storage(STORAGE_KEY, String(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CHANGE_EVENT, { detail: { fontSize: next } }),
    );
  }
  return next;
}

export function useAgentChatFontSize(fallback = 13) {
  const [fontSize, setFontSizeState] = useState<number>(() =>
    readAgentChatFontSize(fallback),
  );

  useEffect(() => {
    setFontSizeState(readAgentChatFontSize(fallback));
  }, [fallback]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (evt: StorageEvent) => {
      if (evt.key && evt.key !== STORAGE_KEY) return;
      setFontSizeState(readAgentChatFontSize(fallback));
    };
    const onChange = (evt: Event) => {
      const detail = (evt as CustomEvent<{ fontSize?: number }>).detail;
      const next = parseFontSize(detail?.fontSize);
      if (next != null) {
        setFontSizeState(next);
        return;
      }
      setFontSizeState(readAgentChatFontSize(fallback));
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange as EventListener);
    };
  }, [fallback]);

  const setFontSize = useCallback((value: number) => {
    const next = writeAgentChatFontSize(value);
    setFontSizeState(next);
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
