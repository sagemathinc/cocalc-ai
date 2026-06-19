set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-jupyter}"
require_gpu="${REQUIRE_GPU:-false}"

python_bin="$prefix/bin/python"
if [ ! -x "$python_bin" ]; then
  python_bin="python3"
fi

REQUIRE_GPU="$require_gpu" "$python_bin" - <<'PY'
import os

import torch
import torchaudio
import torchvision

if not torch.version.cuda:
    raise SystemExit("PyTorch is installed, but the wheel is not CUDA-enabled")

gpu_available = torch.cuda.is_available()
if os.environ.get("REQUIRE_GPU", "false").lower() == "true" and not gpu_available:
    raise SystemExit("No CUDA GPU is visible to PyTorch")

print("torch", torch.__version__)
print("torchvision", torchvision.__version__)
print("torchaudio", torchaudio.__version__)
print("cuda", torch.version.cuda)
print("gpu_available", gpu_available)
PY
