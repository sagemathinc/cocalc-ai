/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import React from "react";
import { Button, Tooltip } from "antd";

import { SlateEditor } from "../editable-markdown";
import { LinkEdit } from "./link-edit";
import { ListProperties } from "./list";
import { ListEdit } from "./list-edit";
import { Marks } from "./marks";
import { MarksBar } from "./marks-bar";
import { Icon } from "@cocalc/frontend/components";

interface Props {
  Search: React.JSX.Element;
  isCurrent?: boolean;
  marks: Marks;
  linkURL: string | undefined;
  listProperties: ListProperties | undefined;
  editor: SlateEditor;
  style?: React.CSSProperties;
  hideSearch?: boolean; // often on SMALL docs, e.g., when embedding in chat, it's pointless to have our own find.
  onHelp?: () => void;
}

const HEIGHT = "25px";

export const EditBar: React.FC<Props> = (props: Props) => {
  const {
    isCurrent,
    Search,
    marks,
    linkURL,
    listProperties,
    editor,
    style,
    hideSearch,
    onHelp,
  } = props;

  function renderContent() {
    return (
      <>
        <MarksBar marks={marks} editor={editor} />
        <LinkEdit linkURL={linkURL} editor={editor} />
        <ListEdit listProperties={listProperties} editor={editor} />
        {!hideSearch && (
          <div style={{ flex: 1, maxWidth: "50ex", marginRight: "15px" }}>
            {Search}
          </div>
        )}
        {onHelp && (
          <Tooltip title="Editor Help" mouseEnterDelay={0.5}>
            <Button
              type="text"
              onClick={onHelp}
              style={{
                height: "24px",
                padding: "0 10px",
                borderLeft: "1px solid lightgray",
                borderRight: "1px solid lightgray",
              }}
            >
              <Icon name="question-circle" />
            </Button>
          </Tooltip>
        )}
      </>
    );
  }

  return (
    <div
      style={{
        borderBottom: isCurrent
          ? "1px solid lightgray"
          : "1px solid transparent",
        height: HEIGHT,
        display: "flex",
        flexDirection: "row",
        overflow: "hidden",
        ...style,
      }}
    >
      {isCurrent && renderContent()}
    </div>
  );
};
