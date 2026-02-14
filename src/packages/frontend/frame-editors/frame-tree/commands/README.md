# Frame Tree Command System

This directory contains the frame title-bar command and menu system:

- command registry (`commands.ts`)
- menu/group registry (`menus.ts`, `generic-menus.ts`)
- runtime dispatch (`manage.tsx`)
- editor menu helper (`editor-menus.ts`)

Developer guide:

- [docs/frame-tree-menus.md](../../../../../../docs/frame-tree-menus.md)

That document explains command registration, menu composition, and the important `actions` vs `editor_actions` vs `frame_actions` context subtleties.
