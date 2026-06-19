set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-jupyter}"
package="${PACKAGE:-tensorflow[and-cuda]}"
create_cuda_symlinks="${CREATE_CUDA_SYMLINKS:-true}"

python_bin="$prefix/bin/python"
if [ ! -x "$python_bin" ]; then
  python_bin="python3"
fi

if [ -x "$prefix/bin/uv" ]; then
  export UV_CACHE_DIR="$prefix/.uv-cache"
  "$prefix/bin/uv" pip install --python "$python_bin" "$package"
  rm -rf "$UV_CACHE_DIR"
else
  "$python_bin" -m pip install --no-cache-dir "$package"
fi

if [ "$create_cuda_symlinks" = "true" ]; then
  tf_dir="$("$python_bin" - <<'PY'
from pathlib import Path

import tensorflow as tf

print(Path(tf.__file__).parent)
PY
)"

  (
    cd "$tf_dir"
    ln -sf ../nvidia/*/lib/*.so* . 2>/dev/null || true
  )

  ptxas="$("$python_bin" - <<'PY'
import importlib.util
from pathlib import Path

spec = importlib.util.find_spec("nvidia.cuda_nvcc")
if spec is None or spec.submodule_search_locations is None:
    raise SystemExit(0)

root = Path(next(iter(spec.submodule_search_locations))).resolve()
for path in root.glob("*/bin/ptxas"):
    print(path)
    break
PY
)"

  if [ -n "$ptxas" ]; then
    ln -sf "$ptxas" "$prefix/bin/ptxas"
  fi
fi
