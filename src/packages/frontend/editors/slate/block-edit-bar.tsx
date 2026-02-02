/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React, { useEffect } from "react";
import { EditBar, useLinkURL, useListProperties, useMarks } from "./edit-bar";
import type { SearchHook } from "./search";
import type { SlateEditor } from "./types";

const BLOCK_EDIT_BAR_HEIGHT = 25;

const EMPTY_SEARCH: SearchHook = {
  decorate: () => [],
  Search: null as any,
  search: "",
  previous: () => undefined,
  next: () => undefined,
  focus: () => undefined,
};

export const BlockEditBar: React.FC<{
  editor: SlateEditor | null;
  isCurrent: boolean;
  updateSignal: number;
  hideSearch?: boolean;
  onHelp?: () => void;
  searchHook?: SearchHook;
}> = ({ editor, isCurrent, updateSignal, hideSearch, onHelp, searchHook }) => {
  if (!editor) {
    return (
      <div
        style={{
          borderBottom: isCurrent
            ? "1px solid lightgray"
            : "1px solid transparent",
          height: BLOCK_EDIT_BAR_HEIGHT,
        }}
      />
    );
  }
  const search = searchHook ?? EMPTY_SEARCH;
  const { marks, updateMarks } = useMarks(editor);
  const { linkURL, updateLinkURL } = useLinkURL(editor);
  const { listProperties, updateListProperties } = useListProperties(editor);

  useEffect(() => {
    updateMarks();
    updateLinkURL();
    updateListProperties();
  }, [updateSignal, updateMarks, updateLinkURL, updateListProperties]);

  return (
    <EditBar
      Search={search.Search ?? EMPTY_SEARCH.Search}
      isCurrent={isCurrent}
      marks={marks}
      linkURL={linkURL}
      listProperties={listProperties}
      editor={editor}
      hideSearch={hideSearch}
      onHelp={onHelp}
    />
  );
};
