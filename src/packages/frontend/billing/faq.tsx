/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Component, Rendered } from "../app-framework";
import { A } from "@cocalc/frontend/components";

export class FAQ extends Component {
  public render(): Rendered {
    return (
      <div>
        <a id="faq" />
        <ul style={{ paddingLeft: "20px" }}>
          <li>
            <A href="/app-docs/billing/settings">
              Billing, quotas, and upgrades
            </A>
          </li>
          <li>
            <A href="/app-docs/projects/project-list">
              Questions about projects
            </A>
          </li>
        </ul>
      </div>
    );
  }
}
