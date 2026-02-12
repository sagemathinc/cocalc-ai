# Modernize File Management

Our frontend UI for file management is really awkward and likely needs a significant revamp, which would mean throwing away that coverage.  Right now:

- user can only view one directory listing at a time in one single project
- there's no way to expand trees (except in that directory selector dialog)
- there's no drag and drop
- all file operations (e.g., move) are very tedious - clicking checkboxes, then an action dropdown, then another dialog, instead of drag and drop.

Goals:

- be able to view multiple directory listings in one or multiple projects on the same screen.  Stateful.
- expand trees, i.e., click toggle to show all files in a directory without having to navigate to that directory
- be able to select a range of items and drag-n-drop copy them from anywhere to anywhere (except /root to non-/root across hosts).
- context menu for file operations (in addition to an File... dropdown menu at the top)