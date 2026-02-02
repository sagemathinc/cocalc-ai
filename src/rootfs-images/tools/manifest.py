#!/usr/bin/env python3
import argparse
import json
from datetime import datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
IMAGES_DIR = ROOT / "images"
ARTIFACTS_DIR = ROOT / "build-artifacts"


def load_image_yaml(path: Path):
    data = yaml.safe_load(path.read_text())
    data["_path"] = str(path)
    return data


def load_artifact(image_id: str):
    path = ARTIFACTS_DIR / f"{image_id}.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--source", default="gcp-artifact-registry")
    args = parser.parse_args()

    images = []
    for image_dir in IMAGES_DIR.iterdir():
        if not image_dir.is_dir():
            continue
        meta_path = image_dir / "image.yaml"
        if not meta_path.exists():
            continue
        meta = load_image_yaml(meta_path)
        artifact = load_artifact(meta["id"])
        entry = {
            "id": meta["id"],
            "label": meta["label"],
            "image": artifact.get("ref") or meta.get("image", ""),
            "description": meta.get("description", ""),
            "digest": artifact.get("digest"),
            "gpu": bool(meta.get("gpu")),
            "priority": meta.get("priority", 0),
            "tags": meta.get("tags", []),
            "prepull": bool(meta.get("prepull")),
            "arch": meta.get("arch"),
        }
        if meta.get("component_version"):
            entry["component_version"] = meta.get("component_version")
        if artifact.get("updated_at"):
            entry["updated_at"] = artifact.get("updated_at")
        images.append(entry)

    manifest = {
        "version": 1,
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "source": args.source,
        "images": images,
    }

    Path(args.out).write_text(json.dumps(manifest, indent=2))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
