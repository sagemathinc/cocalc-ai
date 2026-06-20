set -euo pipefail

command -v sage
command -v python
command -v pip
command -v jupyter
sage --version
sage -c 'from sage.all import ZZ; assert ZZ(2) + ZZ(2) == 4'
python - <<'PY'
import sys
from sage.all import ZZ

assert ZZ(19).is_prime()
print(sys.executable)
PY
pip --version
jupyter kernelspec list
jupyter kernelspec list 2>/dev/null | grep -qi sagemath
jupyter kernelspec list 2>/dev/null | grep -q python3
