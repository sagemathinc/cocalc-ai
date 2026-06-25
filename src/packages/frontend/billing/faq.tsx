/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Component, Rendered } from "../app-framework";
import { DocsLink } from "@cocalc/frontend/docs/link";

export class FAQ extends Component {
  public render(): Rendered {
    return (
      <div>
        <a id="faq" />
        <ul style={{ paddingLeft: "20px" }}>
          <li>
            <DocsLink href="/app-docs/billing/settings" slug="billing/settings">
              Billing, quotas, and upgrades
            </DocsLink>
          </li>
          <li>
            <DocsLink
              href="/app-docs/projects/project-list"
              slug="projects/project-list"
            >
              Questions about projects
            </DocsLink>
          </li>
        </ul>
      </div>
    );
  }
}
