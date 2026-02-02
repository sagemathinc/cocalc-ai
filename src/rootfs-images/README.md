# RootFS Image Build System (GCP Spot + Artifact Registry)

This directory defines a greenfield, customer‑runnable pipeline to build and
publish RootFS OCI images for CoCalc workspaces using GCP Spot instances and
Artifact Registry (for SOC2 scanning).

## Goals

- Build curated RootFS images on cheap GCP Spot instances.
- Run explicit functional tests for each image.
- Push to Artifact Registry and **block** on High/Critical vulnerabilities.
- Generate two manifests:
  - `manifest.testing.json`
  - `manifest.json` (promoted)
- Provide a workflow that customers can fork and run themselves.

## Directory layout

```
rootfs-images/
  images/
    <image-id>/
      image.yaml
      Dockerfile
  tools/
    build.py              # build/test/scan/publish an image
    manifest.py           # generate manifest.testing.json
    promote.py            # promote testing -> prod manifest
    gcp-builder.sh        # optional spot VM runner
  build-artifacts/        # per-image build metadata (digest, size, etc.)
```

## Image metadata (`image.yaml`)

Example:

```yaml
id: pytorch
label: PyTorch
component_version: "2.4.1"
image_name: pytorch
gpu: true
arch: [amd64]
priority: 90
tags: [pytorch, gpu]
prepull: false
description: PyTorch with CUDA support.

tests:
  - name: python
    cmd: "bash -lc 'python3 - <<EOF\nimport torch; print(torch.__version__)\nEOF'"
```

## Tag format

```
<component_version>-YYYY.MM.DD[.N]
```

Examples:
- `1.10.4-2026.02.02`
- `2.4.1-2026.02.02.1`

## Basic usage (local build)

```bash
python3 tools/build.py --image pytorch \
  --registry us-docker.pkg.dev/<gcp-project>/rootfs \
  --project <gcp-project>
```

This will:
1) build (multi‑arch if applicable)
2) run tests
3) push to Artifact Registry
4) check scan results
5) write build metadata to build-artifacts/

## Generate testing manifest

```bash
python3 tools/manifest.py \
  --registry us-docker.pkg.dev/<gcp-project>/rootfs \
  --out manifest.testing.json
```

## Promote manifest

```bash
python3 tools/promote.py \
  --testing manifest.testing.json \
  --out manifest.json
```

## Spot build on GCP (optional)

```bash
./tools/gcp-builder.sh \
  --image pytorch \
  --project <gcp-project> \
  --zone us-central1-a \
  --registry us-docker.pkg.dev/<gcp-project>/rootfs
```

This launches a spot VM, runs the build, uploads logs, then deletes the VM.

## Notes

- GPU images are amd64 only.
- CPU images are amd64 + arm64.
- Scan gating blocks High/Critical vulnerabilities.
- This is a greenfield system; no migration from old compute-server images.
