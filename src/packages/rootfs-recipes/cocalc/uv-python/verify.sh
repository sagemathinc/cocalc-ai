set -euo pipefail

command -v python3
command -v uv
command -v jupyter
python3 - <<'PY'
import ipykernel
import ipywidgets
import jupyterlab
import matplotlib
import notebook
import numpy
import pandas
import scipy
import sympy
PY
jupyter kernelspec list | grep -q 'python3'
