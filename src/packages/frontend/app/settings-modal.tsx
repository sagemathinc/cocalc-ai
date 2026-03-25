/*
Easily show a global settings modal at any point in cocalc by doing

   await redux.getActions("page").settings(name)

This should be used only for various types of configuration that is not
specific to a particular project.  E.g., many of the panels in the Account
tab could also be accessed this way.
*/

import { Modal } from "antd";
import { useActions, useRedux } from "@cocalc/frontend/app-framework";
import { TerminalSettings } from "@cocalc/frontend/account/terminal-settings";
import { EditorSettings } from "@cocalc/frontend/account/editor-settings/editor-settings";
import SupportCreateModal from "@cocalc/frontend/support/create-modal";

// Ensure the billing Actions and Store are created, which are needed for purchases, etc., to work...
import "@cocalc/frontend/billing/actions";

export default function SettingsModal({}) {
  const actions = useActions("page");
  const name = useRedux("page", "settingsModal");

  if (!name) {
    return null;
  }

  const { Component, hideFooter, title, width } = getDescription(name);

  const close = () => {
    actions.settings("");
  };

  // destroyOnHidden so values in quota input, etc. get updated
  return (
    <Modal
      key="settings-modal"
      width={width ?? "800px"}
      destroyOnHidden
      open
      title={title}
      onOk={close}
      onCancel={close}
      cancelButtonProps={
        hideFooter ? undefined : { style: { display: "none" } }
      }
      footer={hideFooter ? null : undefined}
      okText={hideFooter ? undefined : "Close"}
    >
      {hideFooter ? null : <br />}
      {Component != null ? <Component /> : undefined}
    </Modal>
  );
}

function getDescription(name: string): {
  Component?;
  hideFooter?: boolean;
  title?;
  width?: string | number;
} {
  switch (name) {
    case "terminal-settings":
      return { Component: TerminalSettings };
    case "editor-settings":
      return { Component: EditorSettings };
    case "support-ticket":
      return {
        Component: SupportCreateModal,
        hideFooter: true,
        title: "Contact Support",
        width: 960,
      };
    default:
      return {
        title: <div>Unknown component {name}</div>,
      };
  }
}
