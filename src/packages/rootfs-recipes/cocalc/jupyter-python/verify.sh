set -euo pipefail

command -v python3
command -v pip
command -v uv
command -v jupyter
command -v jupyter-lab
command -v jupyter-notebook

python3 - <<'PY'
import bash_kernel
import ipykernel
import ipywidgets
import jupyterlab
import matplotlib
import notebook
import numpy
import pandas
import scipy
import sklearn
import sympy
PY

jupyter kernelspec list | grep -q 'python3'
jupyter kernelspec list | grep -q 'bash'
