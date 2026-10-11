/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
What the shared browser downloads lands in the project's ~/Downloads, as in a
normal browser, whoever clicked: the human in the viewer, or an agent.

Chromium saves into a staging directory it can write and the project can
read (a browser in its own container sees only its run directory, at the same
path as the project does).  When a download completes, this service (in the
project, as the project's user) copies it to ~/Downloads under the name the
site suggested, made safe and unique.

Agents' own download directories: Playwright sets one (in the project's
/tmp), and Chromium saves where the last client said.  So an agent's
Browser.setDownloadBehavior is pointed at the staging directory, and the
finished file is copied to where the agent asked as well, before the agent
hears it is complete; Playwright's download.saveAs() works as usual.

Staging is on the host's disk for a browser in its own container: each
download is limited (as the files a page's file chooser gets are), and so is
how many run at once.
*/

import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { SharedBrowserDownload as DownloadInfo } from "@cocalc/util/shared-browser-protocol";

export type { DownloadInfo };

export const MAX_DOWNLOAD_BYTES = 1024 ** 3;
export const MAX_ACTIVE_DOWNLOADS = 4;

type Send = (method: string, params: object) => Promise<any>;

interface Pending extends DownloadInfo {
  done: Promise<void>;
  finish: () => void;
}

/** A file name from a site, safe in a directory listing and as a path. */
export function safeDownloadName(suggested: string | undefined): string {
  let name = basename(`${suggested ?? ""}`.replace(/\\/g, "/"))
    // Control characters and characters other systems refuse.
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim()
    .replace(/^\.+/, "");
  if (!name) name = "download";
  if (Buffer.byteLength(name) > 200) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

// name.pdf, name (1).pdf, name (2).pdf, ...: the first that does not exist.
async function copyToUnique(source: string, dir: string, name: string) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      await copyFile(source, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw Error(`too many files named ${name}`);
}

export class BrowserDownloads {
  private downloads = new Map<string, Pending>();
  // Where an agent asked for its downloads, and how (see above).
  private agentDir: { path: string; named: boolean } | null = null;

  constructor(
    private readonly options: {
      send: Send;
      // Where Chromium saves (it and the project can see it).
      stagingDir: string;
      // The project's ~/Downloads.
      targetDir: string;
      maxBytes?: number;
      maxActive?: number;
      onChange?: (download: DownloadInfo) => void;
      log?: (message: string) => void;
    },
  ) {}

  /** Chromium saves to the staging directory, and says so. */
  async start(): Promise<void> {
    const { stagingDir } = this.options;
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    // Leftovers of a browser that stopped mid-download.
    for (const entry of await readdir(stagingDir).catch(() => []))
      await rm(join(stagingDir, entry), { recursive: true, force: true });
    await this.reassert();
  }

  /** Ours again, e.g. after the agent that set its own left. */
  async reassert(): Promise<void> {
    this.agentDir = null;
    await this.options.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: this.options.stagingDir,
      eventsEnabled: true,
    });
  }

  /**
   * An agent's Browser.setDownloadBehavior, as Chromium should get it: into
   * the staging directory.  Its own choices (deny) stand.
   */
  agentBehavior(params: any): any {
    if (params?.behavior !== "allow" && params?.behavior !== "allowAndName") {
      if (params?.behavior === "default") this.agentDir = null;
      // "default" would save where the project cannot see: ours instead.
      return params?.behavior === "default"
        ? {
            ...params,
            behavior: "allowAndName",
            downloadPath: this.options.stagingDir,
            eventsEnabled: true,
          }
        : params;
    }
    this.agentDir =
      typeof params.downloadPath === "string" && params.downloadPath
        ? { path: params.downloadPath, named: params.behavior === "allow" }
        : null;
    return {
      ...params,
      behavior: "allowAndName",
      downloadPath: this.options.stagingDir,
      eventsEnabled: true,
    };
  }

  /** Done with this download (copied where it goes), or never started. */
  settled(guid: string): Promise<void> {
    return this.downloads.get(guid)?.done ?? Promise.resolve();
  }

  list(): DownloadInfo[] {
    return [...this.downloads.values()].map(
      ({ done, finish, ...info }) => info,
    );
  }

  /** Chromium's Browser.download* events (on our own connection). */
  onEvent(method: string, params: any): void {
    if (method === "Browser.downloadWillBegin") {
      const guid = `${params?.guid ?? ""}`;
      if (!/^[A-Za-z0-9-]{1,100}$/.test(guid) || this.downloads.has(guid))
        return;
      let finish = () => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      const download: Pending = {
        guid,
        url: `${params?.url ?? ""}`.slice(0, 2000),
        name: safeDownloadName(params?.suggestedFilename),
        state: "inProgress",
        receivedBytes: 0,
        totalBytes: 0,
        done,
        finish,
      };
      this.downloads.set(guid, download);
      const active = [...this.downloads.values()].filter(
        (d) => d.state === "inProgress",
      ).length;
      if (active > (this.options.maxActive ?? MAX_ACTIVE_DOWNLOADS))
        this.stop(download, "too many downloads at once");
      else this.changed(download);
      return;
    }
    if (method !== "Browser.downloadProgress") return;
    const download = this.downloads.get(`${params?.guid ?? ""}`);
    if (!download || download.state !== "inProgress") return;
    download.receivedBytes = Number(params.receivedBytes) || 0;
    download.totalBytes = Number(params.totalBytes) || 0;
    const max = this.options.maxBytes ?? MAX_DOWNLOAD_BYTES;
    if (params.state === "inProgress") {
      if (Math.max(download.receivedBytes, download.totalBytes) > max)
        this.stop(download, `larger than ${Math.round(max / 1024 ** 2)} MB`);
      return;
    }
    if (params.state === "canceled") {
      download.state = "canceled";
      void this.cleanup(download).finally(() => this.changed(download));
      return;
    }
    if (params.state === "completed")
      void this.complete(download).catch((err) => {
        download.state = "canceled";
        download.reason = `${err?.message ?? err}`;
        this.options.log?.(`download ${download.name}: ${download.reason}`);
        void this.cleanup(download).finally(() => this.changed(download));
      });
  }

  close(): void {
    for (const download of this.downloads.values()) download.finish();
    this.downloads.clear();
  }

  private stop(download: Pending, reason: string): void {
    download.reason = reason;
    this.options.log?.(`download ${download.name} stopped: ${reason}`);
    void this.options
      .send("Browser.cancelDownload", { guid: download.guid })
      .catch(() => {});
  }

  private async complete(download: Pending): Promise<void> {
    const source = join(this.options.stagingDir, download.guid);
    const size = (await stat(source)).size;
    if (size > (this.options.maxBytes ?? MAX_DOWNLOAD_BYTES))
      throw Error("too large");
    await mkdir(this.options.targetDir, { recursive: true });
    const suggested = download.name;
    download.path = await copyToUnique(
      source,
      this.options.targetDir,
      download.name,
    );
    download.name = basename(download.path);
    download.receivedBytes = size;
    download.state = "completed";
    // Also where an agent asked (in the project).
    const agentDir = this.agentDir;
    if (agentDir)
      await copyFile(
        source,
        join(agentDir.path, agentDir.named ? suggested : download.guid),
      ).catch((err) =>
        this.options.log?.(`download for the agent: ${err?.message ?? err}`),
      );
    await this.cleanup(download);
    this.changed(download);
  }

  private async cleanup(download: Pending): Promise<void> {
    await rm(join(this.options.stagingDir, download.guid), {
      force: true,
    }).catch(() => {});
    download.finish();
    // Keep the last few for viewers that come later.
    const done = [...this.downloads.values()].filter(
      (d) => d.state !== "inProgress",
    );
    for (const old of done.slice(0, Math.max(0, done.length - 20)))
      this.downloads.delete(old.guid);
  }

  private changed(download: Pending): void {
    const { done, finish, ...info } = download;
    this.options.onChange?.(info);
  }
}
