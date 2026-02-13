/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Modal, Tooltip, message } from "antd";
import { useState } from "react";
import { TimeTravelActions } from "./actions";

interface Props {
  actions: TimeTravelActions;
}

export function PurgeHistory({ actions }: Props) {
  const [pending, setPending] = useState<boolean>(false);

  return (
    <Tooltip title={"Delete all TimeTravel edit history for this file"}>
      <Button
        size="small"
        danger
        loading={pending}
        onClick={() => {
          Modal.confirm({
            title: "Purge edit history?",
            content:
              "This permanently deletes TimeTravel history for this file. The current file contents will be kept.",
            okText: "Purge History",
            okButtonProps: { danger: true },
            cancelText: "Cancel",
            onOk: async () => {
              setPending(true);
              try {
                const result = await actions.purgeHistory();
                message.success(
                  `Purged ${result.deleted} history entries${
                    result.seeded ? "" : " (no baseline reseed)"
                  }.`,
                );
              } catch (err) {
                message.error(`Unable to purge history: ${err}`);
              } finally {
                setPending(false);
              }
            },
          });
        }}
      >
        Purge History
      </Button>
    </Tooltip>
  );
}

