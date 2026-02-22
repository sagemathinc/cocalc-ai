/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Session-scoped browser extension runtime for agent automation.

MVP scope:
- register/unregister a demo hello-world editor extension
- keep extension registrations alive across browser exec calls
- provide introspection via list()
*/

import { React } from "@cocalc/frontend/app-framework";
import {
  register_file_editor,
  unregister_file_editor,
  has_file_editor,
} from "@cocalc/frontend/project-file";

export type BrowserExtensionSummary = {
  id: string;
  name: string;
  version: string;
  kind: "hello-world";
  enabled: boolean;
  file_extensions: string[];
  installed_at: string;
};

export type BrowserInstallHelloWorldOptions = {
  id?: string;
  name?: string;
  version?: string;
  ext?: string | string[];
  title?: string;
  message?: string;
  replace?: boolean;
};

type InstalledExtension = BrowserExtensionSummary & {
  uninstall: () => void;
};

const DEFAULT_EXTENSION_ID = "com.cocalc.hello-world";

const WRAP_STYLE: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%)",
};

const CARD_STYLE: React.CSSProperties = {
  maxWidth: "720px",
  width: "100%",
  border: "1px solid #d9e2ec",
  borderRadius: "12px",
  background: "#ffffff",
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
  padding: "20px",
};

const TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  marginBottom: "8px",
  fontSize: "24px",
  fontWeight: 700,
  color: "#1a365d",
};

const TEXT_STYLE: React.CSSProperties = {
  margin: 0,
  color: "#334e68",
  fontSize: "15px",
  lineHeight: 1.5,
};

function normalizeExtension(ext: unknown): string {
  let clean = `${ext ?? ""}`.trim().toLowerCase();
  if (!clean) {
    throw Error("file extension must be non-empty");
  }
  if (clean.startsWith("*.")) clean = clean.slice(2);
  if (clean.startsWith(".")) clean = clean.slice(1);
  if (!clean) {
    throw Error("file extension must be non-empty");
  }
  if (!/^[a-z0-9._+-]+$/.test(clean)) {
    throw Error(`invalid file extension '${clean}'`);
  }
  return clean;
}

function normalizeExtensions(value: unknown): string[] {
  if (Array.isArray(value)) {
    const out = new Set<string>();
    for (const ext of value) {
      out.add(normalizeExtension(ext));
    }
    if (out.size === 0) {
      throw Error("at least one file extension must be specified");
    }
    return [...out];
  }
  return [normalizeExtension(value ?? "hello")];
}

function makeHelloWorldEditor({
  title,
  message,
}: {
  title: string;
  message: string;
}): React.FC<{ path?: string }> {
  const HelloWorldEditor: React.FC<{ path?: string }> = ({ path }) => {
    return (
      <div style={WRAP_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={TITLE_STYLE}>{title}</h1>
          <p style={TEXT_STYLE}>{message}</p>
          {path != null ? (
            <p style={{ ...TEXT_STYLE, marginTop: "10px", color: "#486581" }}>
              Opened file: {path}
            </p>
          ) : undefined}
        </div>
      </div>
    );
  };
  return HelloWorldEditor;
}

export class BrowserExtensionsRuntime {
  private readonly installed = new Map<string, InstalledExtension>();

  list(): BrowserExtensionSummary[] {
    return [...this.installed.values()].map(({ uninstall, ...summary }) => ({
      ...summary,
    }));
  }

  installHelloWorld(options?: BrowserInstallHelloWorldOptions): BrowserExtensionSummary {
    const id = `${options?.id ?? DEFAULT_EXTENSION_ID}`.trim();
    if (!id) {
      throw Error("extension id must be specified");
    }
    const name = `${options?.name ?? "Hello World"}`.trim() || "Hello World";
    const version = `${options?.version ?? "0.0.1"}`.trim() || "0.0.1";
    const title = `${options?.title ?? "Hello world"}`.trim() || "Hello world";
    const message =
      `${
        options?.message ??
        "This editor was registered dynamically through the browser extension runtime."
      }`.trim() ||
      "This editor was registered dynamically through the browser extension runtime.";
    const replace = !!options?.replace;
    const file_extensions = normalizeExtensions(options?.ext);

    const existing = this.installed.get(id);
    if (existing) {
      if (!replace) {
        throw Error(`extension '${id}' is already installed; set replace=true to reinstall`);
      }
      existing.uninstall();
      this.installed.delete(id);
    }

    for (const ext of file_extensions) {
      if (has_file_editor(ext)) {
        throw Error(
          `cannot register '*.${ext}' for extension '${id}' because an editor is already registered`,
        );
      }
    }

    const component = makeHelloWorldEditor({ title, message });
    register_file_editor({
      ext: file_extensions,
      component,
    });

    const uninstall = () => {
      unregister_file_editor(file_extensions);
    };

    const installed: InstalledExtension = {
      id,
      name,
      version,
      kind: "hello-world",
      enabled: true,
      file_extensions,
      installed_at: new Date().toISOString(),
      uninstall,
    };
    this.installed.set(id, installed);
    return {
      id: installed.id,
      name: installed.name,
      version: installed.version,
      kind: installed.kind,
      enabled: installed.enabled,
      file_extensions: [...installed.file_extensions],
      installed_at: installed.installed_at,
    };
  }

  uninstall(id: string): { ok: true; id: string } {
    const cleanId = `${id ?? ""}`.trim();
    if (!cleanId) {
      throw Error("extension id must be specified");
    }
    const ext = this.installed.get(cleanId);
    if (!ext) {
      throw Error(`extension '${cleanId}' is not installed`);
    }
    ext.uninstall();
    this.installed.delete(cleanId);
    return { ok: true, id: cleanId };
  }

  clear(): void {
    for (const ext of this.installed.values()) {
      try {
        ext.uninstall();
      } catch {
        // ignore cleanup failures
      }
    }
    this.installed.clear();
  }
}
