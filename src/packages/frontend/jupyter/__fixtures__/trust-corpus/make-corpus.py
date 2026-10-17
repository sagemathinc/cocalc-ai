"""
Build the trust-fidelity corpus: a notebook whose cells each produce one kind
of real-world output, executed by a real kernel so the outputs are exactly what
users' notebooks contain.

Used by jupyter/trust-fidelity.browser-test.mjs to measure what renders with
and without notebook trust.  Regenerate with (needs plotly, bokeh, altair,
pandas, jinja2, folium, matplotlib, ipywidgets, ipympl, ipyleaflet, bqplot in
the kernel's environment):

    python make-corpus.py KERNEL_NAME [OUT.ipynb]

The output (several MB: plotly's notebook mode embeds plotly.js) defaults to
/tmp/trust-corpus.ipynb and is not committed.

Each cell starts with a "case: <name>" marker; the browser test keys on it.
"""

import sys
from pathlib import Path

import nbformat
from nbclient import NotebookClient

CASES = {
    "matplotlib-png": """
import matplotlib.pyplot as plt
plt.plot([1, 3, 2]); plt.title("mpl-png"); plt.show()
""",
    "matplotlib-svg": """
from matplotlib_inline.backend_inline import set_matplotlib_formats
set_matplotlib_formats("svg")
import matplotlib.pyplot as plt
plt.plot([3, 1, 2]); plt.title("mpl-svg"); plt.show()
set_matplotlib_formats("png")
""",
    "pandas-table": """
import pandas as pd
pd.DataFrame({"a": [1, 2], "b": ["x", "y"]})
""",
    "pandas-styler": """
import pandas as pd
pd.DataFrame({"a": [1, 2, 3]}).style.highlight_max(color="rgb(255, 255, 0)").set_caption("styled")
""",
    "html-inline-style": """
from IPython.display import HTML
HTML('<span style="color: rgb(200, 0, 0)" class="x">styled span</span>')
""",
    "html-script": """
from IPython.display import HTML
HTML('<div id="html-script-target">before</div><script>document.getElementById("html-script-target").textContent = "script ran";</script>')
""",
    "display-javascript": """
from IPython.display import Javascript, display
display(Javascript('element.text("javascript output ran")'))
""",
    "javascript-sibling": """
from IPython.display import HTML, Javascript, display
display(HTML('<div id="js-sibling-target">sibling before</div>'))
display(Javascript('document.getElementById("js-sibling-target").textContent = "changed by sibling js"'))
""",
    "pdf": """
import io, matplotlib.pyplot as plt
from IPython.display import display
buf = io.BytesIO(); plt.figure(); plt.plot([1, 2]); plt.savefig(buf, format="pdf"); plt.close()
import base64
display({"application/pdf": base64.b64encode(buf.getvalue()).decode()}, raw=True)
""",
    "plotly-cdn": """
import plotly.express as px, plotly.io as pio
pio.renderers.default = "notebook_connected"
px.line(x=[1, 2, 3], y=[1, 3, 2], title="plotly-cdn").show()
""",
    "plotly-init-notebook-mode": """
import plotly.io as pio, plotly.graph_objects as go
pio.renderers.default = "notebook"
go.Figure(go.Bar(x=[1, 2], y=[2, 1])).show()
""",
    "bokeh": """
from bokeh.io import output_notebook, show
from bokeh.plotting import figure
output_notebook(hide_banner=True)
p = figure(width=300, height=200, title="bokeh"); p.line([1, 2, 3], [1, 3, 2]); show(p)
""",
    "altair": """
import altair as alt, pandas as pd
alt.Chart(pd.DataFrame({"x": [1, 2, 3], "y": [1, 3, 2]})).mark_line().encode(x="x", y="y")
""",
    "folium": """
import folium
folium.Map(location=[47.6, -122.3], zoom_start=10)
""",
    "ipywidgets-slider": """
import ipywidgets as w
w.IntSlider(value=3, description="slider")
""",
    "ipywidgets-html": """
import ipywidgets as w
w.HTML('<b>widget html</b>')
""",
    "ipympl": """
%matplotlib widget
import matplotlib.pyplot as plt
plt.figure(); plt.plot([1, 2, 1]); plt.show()
""",
    "ipyleaflet": """
from ipyleaflet import Map
Map(center=(47.6, -122.3), zoom=10)
""",
    "bqplot": """
import bqplot.pyplot as bplt
bplt.figure(); bplt.plot([1, 2, 3], [1, 3, 2]); bplt.show()
""",
}

MARKDOWN = {
    "markdown-inline-style": 'Markdown with <span style="color: rgb(0, 128, 0)">inline style</span> and <b>bold</b>.',
    "markdown-math": "Math $x^2$ and $$\\int_0^1 f$$",
    "markdown-katex-href": "Link in math: $\\href{https://example.com/}{x}$",
    "markdown-mermaid": "```mermaid\ngraph LR\n  A[mermaid start] --> B[mermaid end]\n```",
}


def main() -> None:
    kernel = sys.argv[1] if len(sys.argv) > 1 else "python3"
    nb = nbformat.v4.new_notebook()
    for name, source in MARKDOWN.items():
        nb.cells.append(nbformat.v4.new_markdown_cell(f"<!-- case: {name} -->\n\n{source}"))
    for name, source in CASES.items():
        nb.cells.append(nbformat.v4.new_code_cell(f"# case: {name}\n{source.strip()}"))
    nb.metadata["kernelspec"] = {"name": kernel, "display_name": kernel, "language": "python"}
    NotebookClient(nb, kernel_name=kernel, timeout=180, allow_errors=True).execute()
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/trust-corpus.ipynb")
    nbformat.write(nb, out)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
