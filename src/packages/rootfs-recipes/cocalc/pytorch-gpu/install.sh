set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-jupyter}"
cuda="${CUDA:-cu128}"
index_url="${INDEX_URL:-}"
packages="${PACKAGES:-torch torchvision torchaudio}"

python_bin="$prefix/bin/python"
if [ ! -x "$python_bin" ]; then
  python_bin="python3"
fi

if [ -z "$index_url" ]; then
  index_url="https://download.pytorch.org/whl/$cuda"
fi

if [ -x "$prefix/bin/uv" ]; then
  export UV_CACHE_DIR="$prefix/.uv-cache"
  "$prefix/bin/uv" pip install --python "$python_bin" --index-url "$index_url" $packages
  rm -rf "$UV_CACHE_DIR"
else
  "$python_bin" -m pip install --no-cache-dir --index-url "$index_url" $packages
fi
