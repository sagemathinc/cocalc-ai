/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Modal } from "antd";
import { useIntl } from "react-intl";

import { useActions, useTypedRedux } from "@cocalc/frontend/app-framework";
import { Icon } from "@cocalc/frontend/components";
import { FILE_ACTIONS } from "@cocalc/frontend/project_actions";

import { useProjectContext } from "./context";
import { ActionBox } from "./explorer/action-box";

export default function FileActionModal() {
  const intl = useIntl();
  const { notifyUserFilesystemChange, project_id } = useProjectContext();
  const actions = useActions({ project_id });
  const file_action = useTypedRedux({ project_id }, "file_action");
  const checked_files = useTypedRedux({ project_id }, "checked_files");
  const current_path = useTypedRedux({ project_id }, "current_path_abs") ?? "/";

  if (!actions || !file_action || (checked_files?.size ?? 0) === 0) {
    return null;
  }

  const actionInfo = FILE_ACTIONS[file_action];
  if (!actionInfo) return null;

  const wideModal =
    file_action === "copy" || file_action === "move" || file_action === "share";

  return (
    <Modal
      open
      destroyOnHidden
      footer={null}
      width={wideModal ? "min(95vw, max(75vw, 900px))" : undefined}
      title={
        <span>
          <Icon name={actionInfo.icon ?? "file"} />{" "}
          {intl.formatMessage(actionInfo.name)}
        </span>
      }
      onCancel={() => actions.set_file_action()}
      styles={{
        body: {
          maxHeight: "72vh",
          overflowY: "auto",
          overflowX: "hidden",
        },
      }}
    >
      <ActionBox
        file_action={file_action}
        checked_files={checked_files}
        current_path={current_path}
        project_id={project_id}
        actions={actions}
        onUserFilesystemChange={notifyUserFilesystemChange}
      />
    </Modal>
  );
}
