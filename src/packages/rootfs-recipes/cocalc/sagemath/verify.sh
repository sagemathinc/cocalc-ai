set -euo pipefail

command -v sage
sage --version
sage -c 'from sage.all import ZZ; assert ZZ(2) + ZZ(2) == 4'
jupyter kernelspec list 2>/dev/null | grep -qi sage
