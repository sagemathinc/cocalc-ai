"""Generate the local Markdown demo's bundled plot (requires matplotlib/numpy)."""
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(0, 4 * np.pi, 400)
figure, axes = plt.subplots(figsize=(6.8, 3.3))
axes.plot(x, np.sin(x))
axes.set(xlabel="x", ylabel="sin(x)")
axes.grid(alpha=0.3)
figure.tight_layout()
figure.savefig(Path(__file__).resolve().parent.parent / "assets/preview-plot.png", dpi=100)
