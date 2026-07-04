# CoCalc Friction Cards

Use these cards to turn confusing symptoms into fast action.

## Notebook Output Says `not available`

Likely cause: CoCalc could not render a notebook output path, often
JavaScript-heavy `text/html`.

First response:

- Inspect output MIME types with `project jupyter outputs`.
- Replace JavaScript HTML animations with `image/gif` or `image/png`.
- Leave a bug-report draft if the user-visible error is vague.

Verify: rerun the cell and confirm the output includes `image/gif`,
`image/png`, or another CoCalc-supported non-JavaScript MIME type.

## Kernel Exited Code 15 With VTK/EGL/X Warnings

Likely cause: headless visualization backend trouble, not necessarily a failed
scientific computation.

First response:

- Separate the numerical solve from visualization.
- Prefer Matplotlib static/GIF output.
- Avoid PyVista/VTK/OpenGL unless tested in the CoCalc UI.

Verify: rerun the solve-only cells and then the replacement visualization.

## Permission Denied With `auth_actor: "agent"`

Likely cause: the current token is project-scoped.

First response:

- Do not retry the same command repeatedly.
- State the exact auth boundary.
- Provide the admin UI or admin-authenticated CLI command.

Verify: user or operator reruns from a full admin/fresh-auth session.

## Bare `cocalc` Command Fails Or Targets Wrong Session

Likely cause: PATH or auth environment mismatch.

First response:

- Use the exact runtime CLI command.
- Pass `--project-id` and `--browser` explicitly for browser commands.
- Refresh local dev env with `pnpm -s dev:lite:env` or `pnpm -s dev:hub:env`
  when working in the repo dev environment.

Verify: run `browser files` or a narrow project command and confirm it targets
the expected project/browser.

## Unsaved Notebook Or Editor State Disagrees With Disk

Likely cause: CoCalc collaborative state is live and may not match filesystem
reads.

First response:

- Use `project jupyter ...` for notebooks.
- Use `api.text.open(...).read/replace/append` for text editor state.
- Save through the live API after intentional changes.

Verify: inspect through the same live API and, if needed, save to disk.
