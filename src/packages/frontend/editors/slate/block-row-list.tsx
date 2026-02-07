/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// BlockRowList renders the block rows with optional virtualization.
// It keeps the virtual list wiring separate from block-markdown-editor-core,
// while preserving the same layout and sizing behavior.

import React from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

type BlockRowListProps = {
  blocks: string[];
  blockIds: string[];
  disableVirtualization: boolean;
  renderBlock: (index: number) => React.ReactNode;
  virtuosoRef: React.MutableRefObject<VirtuosoHandle | null>;
  height?: string;
  fontSize: number;
  noVfill?: boolean;
};

export const BlockRowList: React.FC<BlockRowListProps> = ({
  blocks,
  blockIds,
  disableVirtualization,
  renderBlock,
  virtuosoRef,
  height,
  fontSize,
  noVfill,
}) => {
  return (
    <div
      className={noVfill || height === "auto" ? undefined : "smc-vfill"}
      style={{
        width: "100%",
        fontSize,
        height,
      }}
    >
      {disableVirtualization ? (
        <div>
          {blocks.map((_, index) => (
            <React.Fragment key={blockIds[index] ?? index}>
              {renderBlock(index)}
            </React.Fragment>
          ))}
        </div>
      ) : (
        <Virtuoso
          className="smc-vfill"
          totalCount={blocks.length}
          itemContent={(index) => renderBlock(index)}
          computeItemKey={(index) => blockIds[index] ?? index}
          ref={virtuosoRef}
        />
      )}
    </div>
  );
};
