/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * The person chose this thread (a link, find, artifact feedback): select it
 * and, through ChatActions.selectThreadByUser, tell an embedding page such as
 * the agents workspace. Selections made by code call setSelectedThread alone.
 */
export function selectThreadByUser(actions: any, threadKey: string): void {
  if (typeof actions?.selectThreadByUser === "function")
    actions.selectThreadByUser(threadKey);
  else actions?.setSelectedThread?.(threadKey);
}
