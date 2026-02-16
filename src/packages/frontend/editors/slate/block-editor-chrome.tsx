/*
 * This component renders the block editor's top chrome: the toolbar,
 * help modal, path display, and pending-remote indicator. Extracting
 * this keeps the core editor focused on state and rendering logic.
 */

import React from "react";
import { BlockEditBar } from "./block-edit-bar";
import { SlateHelpModal } from "./help-modal";
import type { SearchHook } from "./search";
import type { SlateEditor } from "./types";

interface BlockEditorChromeProps {
  editBarKey: React.Key;
  editor: SlateEditor | null;
  updateSignal: number;
  isCurrent: boolean;
  hideSearch: boolean;
  searchHook: SearchHook;
  onHelp: () => void;
  showHelpModal: boolean;
  onCloseHelp: () => void;
  hidePath?: boolean;
  renderPath?: React.ReactNode;
  showPendingRemoteIndicator: boolean;
  onMergePending: (event: React.SyntheticEvent) => void;
}

export const BlockEditorChrome: React.FC<BlockEditorChromeProps> = ({
  editBarKey,
  editor,
  updateSignal,
  isCurrent,
  hideSearch,
  searchHook,
  onHelp,
  showHelpModal,
  onCloseHelp,
  hidePath,
  renderPath,
  showPendingRemoteIndicator,
  onMergePending,
}) => {
  return (
    <>
      <BlockEditBar
        key={editBarKey}
        editor={editor}
        isCurrent={isCurrent}
        updateSignal={updateSignal}
        hideSearch={hideSearch}
        searchHook={searchHook}
        onHelp={onHelp}
      />
      <SlateHelpModal open={showHelpModal} onClose={onCloseHelp} />
      {!hidePath && renderPath}
      {showPendingRemoteIndicator && (
        <div
          role="button"
          tabIndex={0}
          onMouseDown={onMergePending}
          onClick={onMergePending}
          style={{
            position: "absolute",
            top: hidePath ? 6 : 30,
            right: 8,
            fontSize: 12,
            padding: "2px 8px",
            background: "rgba(255, 251, 230, 0.95)",
            border: "1px solid rgba(255, 229, 143, 0.9)",
            borderRadius: 4,
            color: "#8c6d1f",
            cursor: "pointer",
            zIndex: 3,
          }}
        >
          Remote changes pending
        </div>
      )}
    </>
  );
};
