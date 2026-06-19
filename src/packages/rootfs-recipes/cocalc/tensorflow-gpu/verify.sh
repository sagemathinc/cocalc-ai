set -euo pipefail

prefix="${PREFIX:-/opt/cocalc-jupyter}"
require_gpu="${REQUIRE_GPU:-false}"

python_bin="$prefix/bin/python"
if [ ! -x "$python_bin" ]; then
  python_bin="python3"
fi

REQUIRE_GPU="$require_gpu" "$python_bin" - <<'PY'
import os

import tensorflow as tf

result = tf.reduce_sum(tf.random.normal([128, 128]))
gpus = tf.config.list_physical_devices("GPU")

if os.environ.get("REQUIRE_GPU", "false").lower() == "true" and not gpus:
    raise SystemExit("No CUDA GPU is visible to TensorFlow")

print("tensorflow", tf.__version__)
print("gpu_devices", [gpu.name for gpu in gpus])
print("sample_sum_shape", result.shape)
PY
