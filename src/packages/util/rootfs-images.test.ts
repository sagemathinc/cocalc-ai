/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizeRootfsContentManifest,
  parseRootfsConfigExport,
  validateRootfsSlug,
} from "./rootfs-images";

describe("normalizeRootfsContentManifest", () => {
  it("keeps safe discovery content", () => {
    const result = normalizeRootfsContentManifest({
      version: 1,
      title: "Minimal Image",
      subtitle: "Jupyter and LaTeX",
      publisher: {
        name: "CoCalc",
        url: "https://cocalc.com/",
      },
      license: {
        name: "MIT",
      },
      highlights: ["JupyterLab", "LaTeX"],
      actions: [
        {
          kind: "open",
          label: "Open tutorial",
          path: "/opt/share/tutorial.ipynb",
        },
        {
          kind: "browse",
          label: "Browse examples",
          path: "/opt/share/examples",
        },
        {
          kind: "copy-to-home",
          label: "Copy starter",
          source_path: "/opt/share/starter.ipynb",
          target_path: "starter.ipynb",
        },
        {
          kind: "external-link",
          label: "Documentation",
          url: "https://example.com/docs",
        },
        {
          kind: "project-app",
          label: "Launch Pluto",
          description: "Start the bundled Pluto notebook server.",
          app_spec: {
            version: 1,
            id: "pluto",
            title: "Pluto",
            kind: "service",
            command: {
              exec: "bash",
              args: ["-lc", "pluto --host 127.0.0.1 --port ${PORT}"],
            },
            network: {
              listen_host: "127.0.0.1",
              protocol: "http",
            },
            proxy: {
              base_path: "/apps/pluto",
              strip_prefix: true,
              websocket: true,
              open_mode: "proxy",
              readiness_timeout_s: 45,
            },
            wake: {
              enabled: true,
              keep_warm_s: 1800,
              startup_timeout_s: 120,
            },
          },
        },
      ],
    });

    expect(result.warnings).toEqual([]);
    expect(result.content).toEqual({
      version: 1,
      title: "Minimal Image",
      subtitle: "Jupyter and LaTeX",
      publisher: {
        name: "CoCalc",
        url: "https://cocalc.com/",
      },
      license: {
        name: "MIT",
      },
      highlights: ["JupyterLab", "LaTeX"],
      actions: [
        {
          kind: "open",
          label: "Open tutorial",
          path: "/opt/share/tutorial.ipynb",
        },
        {
          kind: "browse",
          label: "Browse examples",
          path: "/opt/share/examples",
        },
        {
          kind: "copy-to-home",
          label: "Copy starter",
          source_path: "/opt/share/starter.ipynb",
          target_path: "starter.ipynb",
        },
        {
          kind: "external-link",
          label: "Documentation",
          url: "https://example.com/docs",
        },
        {
          kind: "project-app",
          label: "Launch Pluto",
          description: "Start the bundled Pluto notebook server.",
          app_spec: {
            version: 1,
            id: "pluto",
            title: "Pluto",
            kind: "service",
            command: {
              exec: "bash",
              args: ["-lc", "pluto --host 127.0.0.1 --port ${PORT}"],
            },
            network: {
              listen_host: "127.0.0.1",
              protocol: "http",
            },
            proxy: {
              base_path: "/apps/pluto",
              strip_prefix: true,
              websocket: true,
              open_mode: "proxy",
              readiness_timeout_s: 45,
            },
            wake: {
              enabled: true,
              keep_warm_s: 1800,
              startup_timeout_s: 120,
            },
          },
        },
      ],
    });
  });

  it("drops unsafe paths and links with warnings", () => {
    const result = normalizeRootfsContentManifest({
      version: 1,
      title: "Unsafe image",
      highlights: "not an array",
      actions: [
        {
          kind: "open",
          label: "Bad path",
          path: "/opt/../etc/passwd",
        },
        {
          kind: "copy-to-home",
          label: "Bad copy target",
          source_path: "/opt/share/starter.ipynb",
          target_path: "../starter.ipynb",
        },
        {
          kind: "external-link",
          label: "Insecure docs",
          url: "http://example.com/docs",
        },
        {
          kind: "unknown",
          label: "Future action",
        },
        {
          kind: "project-app",
          label: "Bad app",
          app_spec: {
            id: "../bad",
            kind: "service",
          },
        },
      ],
    });

    expect(result.content).toEqual({
      version: 1,
      title: "Unsafe image",
      actions: [],
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "invalid-highlights",
      "invalid-path",
      "invalid-target-path",
      "invalid-url",
      "invalid-action-kind",
      "invalid-app-spec-id",
    ]);
  });

  it("rejects unsupported versions", () => {
    const result = normalizeRootfsContentManifest({
      version: 2,
      title: "Future image",
    });

    expect(result.content).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        code: "unsupported-version",
        message: "Content manifest version must be 1",
        path: "version",
      },
    ]);
  });
});

describe("validateRootfsSlug", () => {
  it("normalizes valid slugs", () => {
    expect(validateRootfsSlug("Minimal-Jupyter")).toBe("minimal-jupyter");
  });

  it("rejects invalid slugs", () => {
    expect(() => validateRootfsSlug("bad slug")).toThrow(
      "name must contain only",
    );
    expect(() => validateRootfsSlug("x".repeat(40))).toThrow(
      "name must have at most 39 characters",
    );
  });
});

describe("parseRootfsConfigExport", () => {
  it("normalizes metadata slugs", () => {
    const result = parseRootfsConfigExport({
      kind: "cocalc-rootfs-config",
      version: 1,
      exported_at: "2026-06-17T00:00:00.000Z",
      metadata: {
        label: "Minimal Jupyter",
        slug: "Minimal-Jupyter",
        default_jupyter_kernel: " sagemath ",
      },
    });

    expect(result.metadata?.slug).toBe("minimal-jupyter");
    expect(result.metadata?.default_jupyter_kernel).toBe("sagemath");
  });
});
