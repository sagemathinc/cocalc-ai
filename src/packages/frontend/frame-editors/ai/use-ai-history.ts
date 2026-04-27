/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
// To debug AI history in the browser console:
c = cc.client.conat_client
// Get the shared AI history streams
stream = await c.dstream({account_id: cc.client.account_id, name: 'llm-history'})
// View prompts
console.log('AI prompts:', stream.getAll())
// Add a prompt to general
stream.push("New prompt")
// Listen to changes
stream.on('change', (prompt) => console.log('New prompt:', prompt))
*/

import { useEffect, useRef, useState } from "react";

import type { DStream } from "@cocalc/conat/sync/dstream";
import { redux } from "@cocalc/frontend/app-framework";
import {
  getSharedAccountDStream,
  resetSharedAccountDStreamCacheForTests,
} from "@cocalc/frontend/conat/account-dstream";
import { CONAT_AI_HISTORY_KEY } from "@cocalc/util/consts";
import { reuseInFlight } from "@cocalc/util/reuse-in-flight";

// limit max prompts to keep in history per type
const MAX_PROMPTS_NUM = 1000;
const MAX_PROMPTS_BYTES = 1024 * 1024;
const SHARED_STREAM_MAX_LISTENERS = 100;

export type AIHistoryType = "general" | "formula" | "generate";

interface AIHistoryEntry {
  type: AIHistoryType;
  prompt: string;
}

const streamResetListeners = new Set<() => void>();

function notifyStreamReset() {
  for (const listener of Array.from(streamResetListeners)) {
    listener();
  }
}

export function resetAIHistoryForTests() {
  streamResetListeners.clear();
  resetSharedAccountDStreamCacheForTests();
}

// Get or create the single shared dstream
const getDStream = reuseInFlight(async () => {
  try {
    // Wait until account is authenticated
    const store = redux.getStore("account");
    await store.async_wait({
      until: () => store.get_account_id() != null,
      timeout: 0, // indefinite timeout
    });

    const account_id = store.get_account_id();
    const stream = await getSharedAccountDStream<AIHistoryEntry>({
      account_id,
      name: CONAT_AI_HISTORY_KEY,
      config: {
        discard_policy: "old",
        max_msgs: MAX_PROMPTS_NUM,
        max_bytes: MAX_PROMPTS_BYTES,
      },
      maxListeners: SHARED_STREAM_MAX_LISTENERS,
    });
    return stream;
  } catch (err) {
    console.warn(`dstream AI history initialization error -- ${err}`);
    throw err;
  }
});

// Hook for managing AI prompt history using dstream
export function useAIHistory(type: AIHistoryType = "general") {
  const [prompts, setPrompts] = useState<string[]>([]);
  const [streamResetToken, setStreamResetToken] = useState(0);

  // Use ref to store stable listener function
  const listenerRef = useRef<((newEntry: AIHistoryEntry) => void) | null>(null);

  // Filter prompts by type and extract just the prompt strings (newest first)
  function filterPromptsByType(entries: AIHistoryEntry[]): string[] {
    return entries
      .filter((entry) => entry.type === type)
      .map((entry) => entry.prompt)
      .reverse();
  }

  useEffect(() => {
    const handleStreamReset = () => {
      setStreamResetToken((n) => n + 1);
    };
    streamResetListeners.add(handleStreamReset);
    return () => {
      streamResetListeners.delete(handleStreamReset);
    };
  }, []);

  // Initialize dstream and set up listeners
  useEffect(() => {
    let isMounted = true;
    let stream: DStream<AIHistoryEntry> | null = null;

    const initializeStream = async () => {
      try {
        stream = await getDStream();

        // Check if component was unmounted while we were waiting
        if (!isMounted) {
          return;
        }

        const allEntries = stream.getAll();
        setPrompts(filterPromptsByType(allEntries));

        // Create stable listener function
        listenerRef.current = (newEntry: AIHistoryEntry) => {
          // Only update if the new entry matches our type
          if (newEntry.type !== type) return;

          setPrompts((prev) => {
            // Remove duplicate if exists, then add to front
            const filtered = prev.filter((p) => p !== newEntry.prompt);
            return [newEntry.prompt, ...filtered];
          });
        };

        // Add our listener to the stream
        stream.on("change", listenerRef.current);
      } catch (err) {
        console.warn(`AI history hook initialization error -- ${err}`);
      }
    };

    initializeStream();

    // Cleanup function for useEffect
    return () => {
      isMounted = false;
      if (stream && listenerRef.current) {
        stream.off("change", listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, [type, streamResetToken]);

  async function addPrompt(prompt: string) {
    const trimmedPrompt = prompt.trim();

    if (!trimmedPrompt) {
      console.warn("use-ai-history: ignoring empty prompt");
      return;
    }

    try {
      const stream = await getDStream();

      // Create entry object with type and prompt
      const entry: AIHistoryEntry = {
        type,
        prompt: trimmedPrompt,
      };

      // Add entry to stream - this will trigger a change event
      stream.push(entry);
    } catch (err) {
      console.warn(`Error adding prompt to AI history -- ${err}`);
    }
  }

  async function clearHistory() {
    try {
      const stream = await getDStream();

      // Clear local state immediately
      setPrompts([]);

      // Delete the stream to clear all history
      await stream.delete();

      notifyStreamReset();
    } catch (err) {
      console.warn(`Error clearing AI history -- ${err}`);
      // Reload prompts on error
      try {
        const stream = await getDStream();
        const allEntries = stream.getAll();
        setPrompts(filterPromptsByType(allEntries));
      } catch (reloadErr) {
        console.warn(
          `Error reloading prompts after clear failure -- ${reloadErr}`,
        );
      }
    }
  }

  return {
    prompts,
    addPrompt,
    clearHistory,
  };
}
