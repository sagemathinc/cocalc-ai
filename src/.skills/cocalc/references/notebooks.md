# Live Jupyter Notebooks

## Source Of Truth

Treat the live in-memory notebook as authoritative. Do not read or edit
`.ipynb` JSON directly for live inspection or mutation unless the user
explicitly asks for filesystem-level work.

Use:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project jupyter -h
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project jupyter exec-api
```

Useful commands:

- `project jupyter kernel --path <notebook>`
- `project jupyter cells --path <notebook>`
- `project jupyter set --path <notebook> --cell-id <id> --stdin`
- `project jupyter insert --path <notebook> ... --stdin`
- `project jupyter clear-output --path <notebook> --all`
- `project jupyter run --path <notebook> --all-code --jsonl`
- `project jupyter outputs --path <notebook> --cell-id <id>`
- `project jupyter save --path <notebook>`

For multi-step automation, prefer `project jupyter exec --path ... --stdin` or
`--file <script.js>` over many small shell calls.

## Editing Pattern

1. List cells and stable IDs.
2. Update by cell ID, not guessed index, when possible.
3. Clear stale outputs after changing display code.
4. Run the relevant cells or full notebook.
5. Inspect outputs for MIME types, errors, and expected domain results.
6. Save the live notebook.

## Rendering Gotchas

Matplotlib `FuncAnimation.to_jshtml()` emits JavaScript-heavy `text/html`. In
CoCalc this can render as only `not available`. Prefer a robust MIME output:

```python
from matplotlib.animation import PillowWriter
from IPython.display import Image, display

animation.save("/tmp/animation.gif", writer=PillowWriter(fps=8))
display(Image(filename="/tmp/animation.gif"))
```

For headless projects, avoid PyVista/VTK/OpenGL examples unless you have tested
them. Warnings such as `bad X server connection`, EGL initialization failures,
or kernel exit code 15 often indicate visualization backend trouble, not a
failed numerical solve.

The standalone `jupyter_client` harness may emit a TCP-without-encryption
warning. In CoCalc notebook validation, distinguish that harness warning from
the actual UI kernel integration.

## Notebook Examples For Science Images

Examples should exercise the installed domain package, not just import it. They
should also render with CoCalc-safe outputs such as `image/png`, `image/gif`,
plain text tables, or simple Matplotlib figures unless richer output has been
tested in the CoCalc UI.
