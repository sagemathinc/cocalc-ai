import { Router } from "express";

const ROOTFS_MANIFEST = {
  version: 1,
  generated_at: "2026-02-02T00:00:00Z",
  source: "hub-fallback",
  images: [
    {
      id: "minimal",
      label: "Minimal Ubuntu",
      image: "ubuntu:25.10",
      description: "Minimal Ubuntu base image for lightweight workspaces.",
      priority: 100,
      tags: ["minimal", "cpu"],
      prepull: true,
    },
    {
      id: "pytorch",
      label: "PyTorch",
      image: "pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime",
      description: "PyTorch with CUDA support.",
      priority: 90,
      gpu: true,
      tags: ["pytorch", "gpu"],
    },
    {
      id: "tensorflow",
      label: "TensorFlow",
      image: "tensorflow/tensorflow:2.16.1-gpu",
      description: "TensorFlow with CUDA support.",
      priority: 85,
      gpu: true,
      tags: ["tensorflow", "gpu"],
    },
    {
      id: "sagemath",
      label: "SageMath",
      image: "sagemath/sagemath:latest",
      description: "Full SageMath environment.",
      priority: 80,
      tags: ["math", "sagemath", "cpu"],
    },
    {
      id: "latex",
      label: "LaTeX",
      image: "texlive/texlive:latest",
      description: "TeX Live full LaTeX environment.",
      priority: 75,
      tags: ["latex", "docs", "cpu"],
    },
    {
      id: "r",
      label: "R",
      image: "rocker/r-ver:4.4.0",
      description: "R language environment.",
      priority: 70,
      tags: ["r", "cpu"],
    },
    {
      id: "lean",
      label: "Lean Theorem Prover",
      image: "leanprover/lean4:latest",
      description: "Lean 4 theorem prover environment.",
      priority: 65,
      tags: ["lean", "cpu"],
    },
    {
      id: "julia",
      label: "Julia",
      image: "julia:1.10",
      description: "Julia language environment.",
      priority: 60,
      tags: ["julia", "cpu"],
    },
    {
      id: "cuda-dev",
      label: "CUDA Dev",
      image: "nvidia/cuda:12.3.1-devel-ubuntu22.04",
      description: "CUDA development toolkit on Ubuntu.",
      priority: 55,
      gpu: true,
      tags: ["cuda", "gpu"],
    },
    {
      id: "jax",
      label: "JAX",
      image: "ghcr.io/google/jax:latest",
      description: "JAX environment (GPU-enabled image).",
      priority: 50,
      gpu: true,
      tags: ["jax", "gpu"],
    },
    {
      id: "anaconda",
      label: "Anaconda",
      image: "continuumio/anaconda3:2024.06",
      description: "Anaconda Python distribution.",
      priority: 45,
      tags: ["conda", "python", "cpu"],
    },
    {
      id: "colab",
      label: "Google Colab",
      image: "gcr.io/deeplearning-platform-release/base-cu121",
      description: "Colab-like GPU image (testing placeholder).",
      priority: 40,
      gpu: true,
      tags: ["colab", "gpu", "testing"],
    },
  ],
};

export default function init(router: Router) {
  const sendManifest = (_req, res) => {
    res.header("Content-Type", "application/json");
    res.send(JSON.stringify(ROOTFS_MANIFEST, null, 2));
  };
  router.get("/rootfs/manifest.json", sendManifest);
  router.get("/rootfs/manifest.testing.json", sendManifest);
}
