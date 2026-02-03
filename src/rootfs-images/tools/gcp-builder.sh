#!/usr/bin/env bash
set -euo pipefail

IMAGE_ID=""
PROJECT=""
ZONE=""
REGISTRY=""
MACHINE_TYPE="n2-standard-8"
NAME_PREFIX="rootfs-builder"
REPO_URL="https://github.com/sagemathinc/cocalc-ai.git"
REPO_TOKEN=""
REPO_TAR_URL=""
GCS_BUCKET=""
GCS_LOCATION="US"
USE_LOCAL=1
LOG_DIR="build-logs"
TAIL_LOGS=1
AUTO_DELETE=1
SERVICE_ACCOUNT=""
AUTO_IAM=1
AUTO_REPO=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image) IMAGE_ID="$2"; shift 2;;
    --project) PROJECT="$2"; shift 2;;
    --zone) ZONE="$2"; shift 2;;
    --registry) REGISTRY="$2"; shift 2;;
    --repo-url) REPO_URL="$2"; shift 2;;
    --repo-token) REPO_TOKEN="$2"; shift 2;;
    --repo-tar) REPO_TAR_URL="$2"; shift 2;;
    --gcs-bucket) GCS_BUCKET="$2"; shift 2;;
    --gcs-location) GCS_LOCATION="$2"; shift 2;;
    --no-local) USE_LOCAL=0; shift;;
    --log-dir) LOG_DIR="$2"; shift 2;;
    --no-tail) TAIL_LOGS=0; shift;;
    --no-delete) AUTO_DELETE=0; shift;;
    --service-account) SERVICE_ACCOUNT="$2"; shift 2;;
    --no-iam-binding) AUTO_IAM=0; shift;;
    --no-repo-create) AUTO_REPO=0; shift;;
    --machine-type) MACHINE_TYPE="$2"; shift 2;;
    --name-prefix) NAME_PREFIX="$2"; shift 2;;
    *) echo "unknown arg $1"; exit 1;;
  esac
done

if [[ -z "$IMAGE_ID" || -z "$PROJECT" || -z "$ZONE" || -z "$REGISTRY" ]]; then
  echo "usage: gcp-builder.sh --image <id> --project <gcp-project> --zone <zone> --registry <artifact-registry> [--repo-url <url>] [--repo-token <token>] [--repo-tar <url>] [--gcs-bucket <bucket>] [--gcs-location <loc>] [--no-local] [--log-dir <dir>] [--no-tail] [--no-delete] [--service-account <email>] [--no-iam-binding] [--no-repo-create]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
ROOTFS_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

upload_local_tree() {
  if ! command -v gsutil >/dev/null 2>&1; then
    echo "gsutil is required for local uploads. Install Google Cloud SDK (gsutil) or pass --no-local / --repo-tar." >&2
    exit 1
  fi

  local safe_project="${PROJECT//_/-}"
  local bucket="${GCS_BUCKET:-${safe_project}-rootfs-images-builds}"
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local object="rootfs-images-${IMAGE_ID}-${timestamp}-$$-${RANDOM}.tgz"
  local tarball
  local bucket_created=0
  tarball="$(mktemp "/tmp/rootfs-images-${IMAGE_ID}-${timestamp}-XXXXXX.tgz")"

  echo "Packaging local rootfs-images from $ROOTFS_DIR"
  tar -czf "$tarball" -C "$ROOTFS_DIR" .

  if ! gsutil ls -b "gs://$bucket" >/dev/null 2>&1; then
    echo "Creating bucket gs://$bucket in $GCS_LOCATION"
    gsutil mb -p "$PROJECT" -l "$GCS_LOCATION" "gs://$bucket"
    bucket_created=1
  fi

  if [[ "$bucket_created" -eq 1 ]]; then
    local lifecycle_tmp
    lifecycle_tmp="$(mktemp "/tmp/rootfs-images-lifecycle-XXXXXX.json")"
    cat >"$lifecycle_tmp" <<'JSON'
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 7 }
    }
  ]
}
JSON
    echo "Setting bucket lifecycle (delete objects after 7 days)"
    gsutil lifecycle set "$lifecycle_tmp" "gs://$bucket"
    rm -f "$lifecycle_tmp"
  fi

  echo "Uploading build context to gs://$bucket/$object"
  gsutil cp "$tarball" "gs://$bucket/$object"

  echo "Making build context object public-read (temporary)."
  gsutil acl ch -u AllUsers:R "gs://$bucket/$object"

  rm -f "$tarball"

  REPO_TAR_URL="https://storage.googleapis.com/$bucket/$object"
  echo "Using build context tarball: $REPO_TAR_URL"
}

if [[ -n "$REPO_TAR_URL" ]]; then
  USE_LOCAL=0
fi

if [[ "$USE_LOCAL" -eq 1 ]]; then
  upload_local_tree
fi

REGISTRY_HOST="${REGISTRY%%/*}"
REGISTRY_REST="${REGISTRY#*/}"
REGISTRY_PROJECT="${REGISTRY_REST%%/*}"
REGISTRY_REPO="${REGISTRY_REST#*/}"
REGISTRY_REPO="${REGISTRY_REPO%%/*}"
REGISTRY_LOCATION="${REGISTRY_HOST%-docker.pkg.dev}"
if [[ "$REGISTRY_LOCATION" == "$REGISTRY_HOST" ]]; then
  REGISTRY_LOCATION="us"
fi

if [[ "$AUTO_IAM" -eq 1 ]]; then
  SA_TO_BIND="$SERVICE_ACCOUNT"
  if [[ -z "$SA_TO_BIND" ]]; then
    PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
    SA_TO_BIND="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  fi
  echo "Ensuring Artifact Registry writer role for $SA_TO_BIND"
  gcloud projects add-iam-policy-binding "$PROJECT" \
    --member "serviceAccount:$SA_TO_BIND" \
    --role "roles/artifactregistry.writer" >/dev/null
fi

if [[ "$AUTO_REPO" -eq 1 ]]; then
  if ! gcloud artifacts repositories describe "$REGISTRY_REPO" \
    --location "$REGISTRY_LOCATION" \
    --project "$PROJECT" >/dev/null 2>&1; then
    echo "Creating Artifact Registry repo $REGISTRY_REPO in $REGISTRY_LOCATION"
    gcloud artifacts repositories create "$REGISTRY_REPO" \
      --location "$REGISTRY_LOCATION" \
      --repository-format docker \
      --project "$PROJECT" \
      --description "CoCalc rootfs images"
  fi
fi

NAME="${NAME_PREFIX}-${IMAGE_ID}-$(date +%s)"
STARTUP_SCRIPT=$(mktemp)
cat >"$STARTUP_SCRIPT" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/rootfs-build.log) 2>&1
trap 'echo "BUILD FAILED (line $LINENO)"; exit 1' ERR

IMAGE_ID="${IMAGE_ID}"
REGISTRY="${REGISTRY}"
PROJECT="${PROJECT}"
REPO_URL="${REPO_URL}"
REPO_TOKEN="${REPO_TOKEN}"
REPO_TAR_URL="${REPO_TAR_URL}"
AUTO_DELETE="${AUTO_DELETE}"
REGISTRY_HOST="${REGISTRY_HOST}"

self_delete() {
  set +e
  local token zone name project_id
  project_id="$(curl -fs -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/project-id)"
  zone="$(curl -fs -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/zone | awk -F/ '{print $NF}')"
  name="$(curl -fs -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name)"
  token="$(curl -fs -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')"
  echo "Requesting instance deletion: ${project_id}/${zone}/${name}"
  curl -fsS -X DELETE \
    -H "Authorization: Bearer ${token}" \
    "https://compute.googleapis.com/compute/v1/projects/${project_id}/zones/${zone}/instances/${name}"
  set -e
}

cleanup() {
  local status=$?
  if [[ $status -eq 0 ]]; then
    echo "BUILD SUCCESS"
  else
    echo "BUILD FAILED (exit $status)"
  fi
  if [[ "$AUTO_DELETE" -eq 1 ]]; then
    echo "Auto-deleting build instance..."
    self_delete || echo "Instance deletion request failed."
  else
    echo "Auto-delete disabled; instance will remain running."
  fi
}
trap cleanup EXIT

echo "=== rootfs-images build starting ==="
date -u

apt-get update -y
apt-get install -y git docker.io qemu-user-static python3 python3-yaml curl ca-certificates
systemctl start docker
if ! docker buildx version >/dev/null 2>&1; then
  echo "Installing docker buildx plugin"
  arch="$(uname -m)"
  case "$arch" in
    x86_64) arch="amd64";;
    aarch64) arch="arm64";;
    *) echo "Unsupported arch for buildx: $arch"; exit 1;;
  esac
  buildx_version="$(curl -fsSL https://api.github.com/repos/docker/buildx/releases/latest | python3 -c 'import sys, json; print(json.load(sys.stdin)["tag_name"])' || true)"
  if [[ -z "$buildx_version" ]]; then
    buildx_version="v0.31.1"
  fi
  plugin_dir="/usr/lib/docker/cli-plugins"
  if [[ -d /usr/libexec/docker/cli-plugins ]]; then
    plugin_dir="/usr/libexec/docker/cli-plugins"
  fi
  mkdir -p "$plugin_dir"
  curl -fsSL "https://github.com/docker/buildx/releases/download/${buildx_version}/buildx-${buildx_version}.linux-${arch}" \
    -o "$plugin_dir/docker-buildx"
  chmod +x "$plugin_dir/docker-buildx"
fi
docker buildx version || true
docker run --privileged --rm tonistiigi/binfmt --install all
docker buildx create --use --name cocalc-builder || docker buildx use cocalc-builder
docker buildx inspect --bootstrap

ACCESS_TOKEN="$(curl -fs -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')"
echo "$ACCESS_TOKEN" | docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}"

WORKDIR=/root/rootfs-images
mkdir -p "$WORKDIR"
BUILD_DIR="$WORKDIR/src/rootfs-images"

if [[ -n "$REPO_TAR_URL" ]]; then
  echo "Downloading repo tarball from $REPO_TAR_URL"
  curl -fsSL "$REPO_TAR_URL" | tar -xz -C "$WORKDIR" --strip-components=1
  BUILD_DIR="$WORKDIR"
else
  if [[ -n "$REPO_TOKEN" ]]; then
    AUTH_URL="https://${REPO_TOKEN}@${REPO_URL#https://}"
  else
    AUTH_URL="$REPO_URL"
  fi
  if [[ ! -d "$WORKDIR/.git" ]]; then
    git clone "$AUTH_URL" "$WORKDIR"
  fi
fi

if [[ ! -d "$BUILD_DIR" ]]; then
  echo "Build directory not found: $BUILD_DIR"
  echo "Contents of $WORKDIR:"
  ls -la "$WORKDIR"
  exit 1
fi

cd "$BUILD_DIR"
python3 tools/build.py --image "$IMAGE_ID" --registry "$REGISTRY" --project "$PROJECT"
echo "=== rootfs-images build finished ==="
date -u
SCRIPT

# Replace variables in startup script
sed -i "s|\${IMAGE_ID}|$IMAGE_ID|g" "$STARTUP_SCRIPT"
sed -i "s|\${REGISTRY}|$REGISTRY|g" "$STARTUP_SCRIPT"
sed -i "s|\${PROJECT}|$PROJECT|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_URL}|$REPO_URL|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_TOKEN}|$REPO_TOKEN|g" "$STARTUP_SCRIPT"
sed -i "s|\${REPO_TAR_URL}|$REPO_TAR_URL|g" "$STARTUP_SCRIPT"
sed -i "s|\${AUTO_DELETE}|$AUTO_DELETE|g" "$STARTUP_SCRIPT"
sed -i "s|\${REGISTRY_HOST}|$REGISTRY_HOST|g" "$STARTUP_SCRIPT"

set -x

gcloud compute instances create "$NAME" \
  --project "$PROJECT" \
  --zone "$ZONE" \
  --machine-type "$MACHINE_TYPE" \
  --provisioning-model=SPOT \
  --instance-termination-action=DELETE \
  --maintenance-policy=TERMINATE \
  ${SERVICE_ACCOUNT:+--service-account "$SERVICE_ACCOUNT"} \
  --scopes=https://www.googleapis.com/auth/cloud-platform \
  --metadata-from-file startup-script="$STARTUP_SCRIPT" \
  --boot-disk-size=200GB \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${NAME}.serial.log"

if [[ "$TAIL_LOGS" -eq 1 ]]; then
  echo "Tailing serial console logs to $LOG_FILE"
  gcloud compute instances tail-serial-port-output "$NAME" --zone "$ZONE" --port 1 >"$LOG_FILE" 2>&1 &
  TAIL_PID=$!
else
  echo "Serial console logs will not be tailed. Use:"
  echo "  gcloud compute instances get-serial-port-output $NAME --zone $ZONE --port 1 > $LOG_FILE"
fi

echo "Instance $NAME created in $ZONE."
echo "Log file: $LOG_FILE"
if [[ "$AUTO_DELETE" -eq 1 ]]; then
  echo "Auto-delete is enabled; instance will delete on success or failure."
else
  echo "Auto-delete is disabled; delete manually when done:"
  echo "  gcloud compute instances delete $NAME --zone $ZONE"
fi
