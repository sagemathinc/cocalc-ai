/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

/** Only the latest view of each still-mounted runtime can be revealed as-is. */
export class RetainedWorkspaceNavigation {
  private views = new Map<
    string,
    { url: string; account: string; runtime: object }
  >();

  remember(tab: string, url: string, account: string, runtime: object) {
    this.views.delete(tab);
    this.views.set(tab, { url, account, runtime });
  }

  latest(account: string, runtime: (tab: string) => object | undefined) {
    const entry = [...this.views.entries()].at(-1);
    if (!entry) return;
    const [tab, view] = entry;
    if (view.account !== account || runtime(tab) !== view.runtime) {
      this.views.clear();
      return;
    }
    return { tab, url: view.url };
  }

  find(
    url: string,
    account: string,
    runtime: (tab: string) => object | undefined,
  ) {
    for (const [tab, view] of this.views) {
      if (view.account !== account || runtime(tab) !== view.runtime) {
        this.views.delete(tab);
        continue;
      }
      if (view.url === url) return tab;
    }
  }
}
