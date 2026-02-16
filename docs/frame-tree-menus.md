# Frame Tree Menus

This document explains how frame title-bar menus are defined and executed, and the important action-context subtleties.

## Core pieces

- Menu and command registries:
  - [src/packages/frontend/frame-editors/frame-tree/commands/menus.ts](../src/packages/frontend/frame-editors/frame-tree/commands/menus.ts)
  - [src/packages/frontend/frame-editors/frame-tree/commands/commands.ts](../src/packages/frontend/frame-editors/frame-tree/commands/commands.ts)
- Menu builder helper:
  - [src/packages/frontend/frame-editors/frame-tree/commands/editor-menus.ts](../src/packages/frontend/frame-editors/frame-tree/commands/editor-menus.ts)
- Runtime command dispatcher:
  - [src/packages/frontend/frame-editors/frame-tree/commands/manage.tsx](../src/packages/frontend/frame-editors/frame-tree/commands/manage.tsx)
- Title bar render pipeline:
  - [src/packages/frontend/frame-editors/frame-tree/title-bar.tsx](../src/packages/frontend/frame-editors/frame-tree/title-bar.tsx)

## Data flow

1. Editor modules register menu entries and command definitions (often via `addEditorMenus`).
2. Global menu structure is stored in `MENUS` + `GROUPS`; command metadata is in `COMMANDS`.
3. `FrameTitleBar` creates a `ManageCommands` instance for the active frame.
4. `ManageCommands` filters visible commands, applies ordering, builds Ant menu items, and executes handlers.

## `addEditorMenus` behavior

`addEditorMenus` is a convenience wrapper that:

- Creates one or more menu groups for your editor.
- Prefixes command ids as `<prefix>-<name>`.
- Registers menus/groups/commands in the global registries.
- Returns the set of generated command names, which should be added to the editor's `commands` set.

Example:

```ts
const names = addEditorMenus({
  prefix: "timetravel",
  editorMenus: {
    history: {
      label: "History",
      pos: 0.75,
      entries: { actions: ["export_history", "purge_history"] },
    },
  },
  getCommand: (name) => ({ ... }),
});
for (const name of names) editorCommands[name] = true;
```

## The subtle part: which actions does a command use?

In command callbacks, these can differ:

- `props.actions`: ambient/root actions for the frame tree/tab.
- `props.editor_actions`: actions for the current editor instance.
- `frame_actions`: resolved per-frame actions for `props.id` (added in `ManageCommands`).

For plain editors, these are often effectively the same. For subframes (notably TimeTravel and Jupyter internals), they may differ.

### Current recommendation

In menu command callbacks, prefer:

```ts
const actions = frame_actions ?? props.editor_actions ?? props.actions;
```

Then call methods on `actions`.

This avoids bugs where callbacks accidentally invoke the ambient/root actions and target the wrong object.

## How `frame_actions` is resolved

`ManageCommands` attempts (in order):

1. `props.actions.get_frame_actions(props.id)` (Jupyter-style accessor)
2. `props.actions.frame_actions[props.id]` (id-indexed map)
3. `props.actions.frame_actions` if it is itself an actions object
4. TimeTravel special case: `props.actions.timeTravelActions`
5. Fallback: `props.editor_actions`

See [src/packages/frontend/frame-editors/frame-tree/commands/manage.tsx](../src/packages/frontend/frame-editors/frame-tree/commands/manage.tsx).

## Popconfirm and default dispatch

- If command config defines `popconfirm`, `ManageCommands` shows confirmation before running `onClick`.
- If command has no `onClick`, default dispatch is:
  - `props.actions[name]?.(props.id)`

This default is convenient, but for subframe-sensitive operations you usually want an explicit `onClick` and resolved actions as above.

## Subframe-specific notes

### TimeTravel

- TimeTravel can appear as a subframe and has its own actions object.
- If callbacks use ambient actions only, actions like purge/export can target the wrong context.
- Reference:
  - [src/packages/frontend/frame-editors/time-travel-editor/editor.ts](../src/packages/frontend/frame-editors/time-travel-editor/editor.ts)
  - [src/packages/frontend/frame-editors/time-travel-editor/actions.ts](../src/packages/frontend/frame-editors/time-travel-editor/actions.ts)

### Jupyter

- Jupyter frequently uses per-frame actions (`get_frame_actions(id)`), distinct from ambient actions.
- Reference:
  - [src/packages/frontend/frame-editors/jupyter-editor/editor.ts](../src/packages/frontend/frame-editors/jupyter-editor/editor.ts)
  - [src/packages/frontend/frame-editors/jupyter-editor/actions.ts](../src/packages/frontend/frame-editors/jupyter-editor/actions.ts)

## Import-cycle caution

When registering menus inside an editor module, prefer importing `addEditorMenus` from the direct file:

- [src/packages/frontend/frame-editors/frame-tree/commands/editor-menus.ts](../src/packages/frontend/frame-editors/frame-tree/commands/editor-menus.ts)

instead of the broader barrel if an import cycle appears. This avoided a runtime `addEditorMenus` undefined crash in TimeTravel initialization.

## Debugging checklist

- Confirm command is visible:
  - Editor spec includes it and doesn't include `-<command>`.
- Log action identities in `onClick`:
  - `props.actions.name`, `props.editor_actions.name`, `props.id`.
- Verify `frame_actions` resolves and has expected method.
- Check command group + menu ordering (`group`, `pos`).
- Check whether default dispatch is being used unintentionally.

