# Revamp the Launcher

## 1\) Personalization model (global → project → user)

You want OS‑like defaults + per‑project + per‑user. We can treat it like layered config:

- **Global defaults** (vendor/admin): define initial pinned items + app order
- **Project defaults**: team-specific “quick create” (e.g. LaTeX for a paper project)
- **User overrides**: the personal dock

**Merge rule:** `global ⟶ project ⟶ user`  
If user pins something, it appears regardless of project defaults. If a project “requires” a default (like LaTeX), it shows for all collaborators unless they hide it locally.

---

## 2\) Launcher structure (minimal overwhelm)

**Top row**:

- **“Create with AI…”** input (one line)
- A compact **“New file”** dropdown for quick creation (text, notebook, terminal, folder)

**Main section**:

- **Quick Create** (dock/favorites): 6–10 tiles max, user editable
- **Apps**: VS Code, JupyterLab, etc., with a short explanation “Opens a full IDE in a new tab”
- **Browse**: collapsible categories + search. Avoid giant list by default.

---

## 3\) AI create flow (agentic + guided)

AI entry should:

- Ask 1–3 questions (language, library, data source, project type)
- Optionally install libraries or start an app server
- Output:
  - A file (notebook, script, LaTeX project)
  - Or an app launch (JupyterLab/VS Code) with instructions in a new tab

This keeps the “AI” action consistent with OS/app behavior, instead of just a modal text generator.

---

## 4\) App Servers as first‑class items

Treat apps as “launchable IDEs” with status:

- **Launch** (spawns server + opens tab)
- **Running** (shows “Open” + logs)
- **Recent** (put last used app in Quick Create)

This solves the split between “New file” and “Servers”.

---

## 5\) Short‑term wins (low effort)

- Remove X11 desktop button (deprecated)
- Add a Quick Create row (pinned defaults)
- Put app servers on the same page as first‑class tiles
- AI entry at top with basic routing (even if simple at first)



## Plan (detailed)

### Phase 0 — Inventory + constraints (1–2 days)

- **Map current code paths** for the New page and Servers page, including where file types, templates, categories, and actions are defined.
- **Enumerate all creation actions** (files, templates, folders, uploads, git clone, servers).
- **Identify existing metadata** (icons, labels, descriptions, tags) that can power a unified catalog.
- **Decide a storage location** for defaults and user/project overrides (likely in existing settings store or project metadata).

### Phase 1 — Unify IA without behavior changes (2–4 days)

- **Create a Launcher layout** that simply *re‑renders existing actions*:
  - Top row: AI entry + “New file” dropdown (reuse existing handlers)
  - Quick Create: placeholder using current “top” file types
  - Apps: reuse Servers list as tiles (no backend changes)
  - Browse: existing grouped list, but collapsible + searchable
- **Remove X11 button** (deprecated)
- **Add status/labels** for app servers (Launch/Open/Running)
- **Add instrumentation** for which actions users actually click (future personalization)

### Phase 2 — Personalization plumbing (3–6 days)

- **Define data model**:
  - `global_defaults` (admin/vendor)
  - `project_defaults` (project settings)
  - `user_pins` (user preferences)
- **Merge behavior**: `global ⟶ project ⟶ user`
- **UI: “pin/unpin” actions** on tiles, stored per user
- **Project‑level defaults UI** (simple list of defaults in project settings)
- **Admin defaults** configurable via a JSON or db setting (can be seeded)

### Phase 3 — AI create (guided + agentic) (4–8 days)

- **Single AI entry**: “Describe what you want to create…”
- **Lightweight guided flow**: ask 1–3 questions (language, data source, output type)
- **Action handoff**: convert AI choice into either:
  - File creation with templated content
  - App server launch (JupyterLab/VSCode)
- **Optional agentic steps**: install libraries, create environment files
- **Safety**: clear confirmation before executing installs/long tasks

### Phase 4 — Refine & test (ongoing)

- **UX polish**: reduce clutter, ensure new users see obvious next steps
- **Metrics**: completion time for “first file created”, click‑through to Apps, AI usage
- **A/B**: test with Quick Create emphasis vs Browse emphasis

---

## Implementation notes

- **Keep changes incremental**; Phase 1 can ship without storage changes.
- **App Servers** should be first‑class but still open in new tab as today.
- **AI** should not block normal creation—always keep manual path obvious.
