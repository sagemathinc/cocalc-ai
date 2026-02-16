/*
 *  This file is part of CoCalc: Copyright © 2022 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { set_local_storage } from "@cocalc/frontend/misc/local-storage";
import { Form, Switch } from "antd";

export function ToggleExplanations({ showExplanations, setShowExplanations }) {
  return (
    <Form.Item wrapperCol={{ offset: 0, span: 24 }}>
      <div
        style={{ float: "right", cursor: "pointer" }}
        onClick={() => setShowExplanations(!showExplanations)}
      >
        <Switch
          checked={showExplanations}
          onChange={(show) => {
            setShowExplanations(show);
            // TODO: move this key to a centralized constants module.
            set_local_storage("store_show_explanations", show ? "t" : "");
          }}
        />{" "}
        Show explanations
      </div>
    </Form.Item>
  );
}
