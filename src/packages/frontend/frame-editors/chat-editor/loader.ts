/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Lazy-load the chat editor and its actions as one async chunk. Safari can expose
webpack module-registry races when restored chat tabs request the editor and
actions chunks separately during page refresh.
*/

export { Editor as component } from "./editor";
export { Actions } from "./actions";
