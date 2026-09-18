/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MIT (same as slate uses https://github.com/ianstormtaylor/slate/blob/master/License.md)
 */

/* Adapted from
       https://github.com/ianstormtaylor/slate/blob/master/site/examples/mentions.tsx
   One thing that makes this implementation more complicated is that if you just type
   the @ symbol and nothing else, it immediately pops up the mentions dialog.  In
   the demo above, it does not, which is EXTREMELY disconcerting.
*/

import { Editor, Range, Text, Transforms } from "slate";
import { ReactEditor } from "../slate-react";
import React from "react";
import { useIsMountedRef } from "@cocalc/frontend/app-framework";
import { useCallback, useEffect, useState } from "react";
import { Complete } from "@cocalc/frontend/editors/markdown-input/complete";
import type { Item } from "@cocalc/frontend/editors/markdown-input/complete";
import { debounce } from "lodash";

interface Options {
  editor: ReactEditor;
  insertMention: (Editor, string) => void;
  matchingUsers: (search: string) => Item[];
  isVisible?: boolean;
}

interface MentionsControl {
  onChange: () => void;
  onKeyDown: (event) => void;
  Mentions: React.JSX.Element | undefined;
}

export function mentionQueryAtCursor(
  text: string,
  offset: number,
): { start: number; search: string } | undefined {
  if (
    offset < 0 ||
    offset > text.length ||
    (text[offset] && !/\s/.test(text[offset]))
  )
    return;
  const match = text.slice(0, offset).match(/(?:^|[\s([])@([\w-]*)$/);
  if (!match) return;
  return { start: offset - match[1].length - 1, search: match[1] };
}

export const useMentions: (options: Options) => MentionsControl = ({
  isVisible,
  editor,
  insertMention,
  matchingUsers,
}) => {
  const [target, setTarget] = useState<Range | undefined>();
  const [search, setSearch] = useState("");
  const isMountedRef = useIsMountedRef();

  useEffect(() => {
    if (!isVisible && target) {
      setTarget(undefined);
    }
  }, [isVisible]);

  const items = matchingUsers(search.toLowerCase());

  const onKeyDown = useCallback(
    (event) => {
      if (target == null) return;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowUp":
        case "ArrowLeft":
        case "ArrowRight":
        case "Tab":
        case "Enter":
          event.preventDefault();
          break;
        case "Escape":
          event.preventDefault();
          setTarget(undefined);
          break;
      }
    },
    [target],
  );

  // we debounce this onChange, since it is VERY expensive and can make typing feel
  // very laggy on a large document!
  const onChange = useCallback(
    debounce(() => {
      try {
        if (!isMountedRef.current) return;
        const { selection } = editor;
        if (selection && Range.isCollapsed(selection)) {
          const { focus } = selection;
          let current;
          try {
            [current] = Editor.node(editor, focus);
          } catch (_err) {
            // I think due to debounce, somehow this Editor.node above is
            // often invalid while user is typing.
            return;
          }
          if (Text.isText(current)) {
            // Slate's word boundaries split on hyphens, but agent names do not.
            const query = mentionQueryAtCursor(current.text, focus.offset);
            if (query) {
              setTarget({
                focus,
                anchor: {
                  path: focus.path,
                  offset: query.start,
                },
              });
              setSearch(query.search);
              return;
            }
          }
        }

        setTarget(undefined);
      } catch (err) {
        console.log("WARNING -- slate.mentions", err);
      }
    }, 250),
    [editor],
  );
  useEffect(() => () => onChange.cancel(), [onChange]);

  const renderMentions = useCallback(() => {
    if (target == null) return;
    let domRange;
    try {
      domRange = ReactEditor.toDOMRange(editor, target);
    } catch (_err) {
      // target gets set by the onChange handler above, so editor could
      // have changed by the time we call toDOMRange here, making
      // the target no longer meaningful.  Thus this try/catch is
      // completely reasonable (alternatively, when we deduce the target,
      // we also immediately set the domRange in a ref).
      return;
    }

    const onSelect = (value) => {
      Transforms.select(editor, target);
      insertMention(editor, value);
      setTarget(undefined);
      ReactEditor.focus(editor);
      // Move the cursor forward 2 spaces:
      Transforms.move(editor, { distance: 2, unit: "character" });
    };

    const rect = domRange.getBoundingClientRect();
    return React.createElement(Complete, {
      items,
      onSelect,
      onCancel: () => setTarget(undefined),
      position: {
        top: rect.bottom,
        left: rect.left + rect.width,
      },
    });
  }, [editor, insertMention, items, target]);

  return {
    onChange,
    onKeyDown,
    Mentions: renderMentions(),
  };
};
