/*
 * /cli/*: the CoCalc CLI, served by every hub under its own origin
 * (distribution Phase A, src/.agents/cli-distribution-2026-10-12.md).
 *
 *   /cli/install.sh                    installer for the current release
 *   /cli/site.json                     current release and minimum release
 *   /cli/manifests/<sha256>.json       release manifests (immutable)
 *   /cli/files/<manifest>/<sha256>     files a manifest lists (immutable)
 *
 * Content-addressed responses are cacheable forever at the edge; site.json
 * and install.sh briefly.
 */

import type { Request, Response, Router } from "express";
import siteURL from "@cocalc/database/settings/site-url";
import { installScript } from "@cocalc/server/cli-distribution/install-script";
import {
  CliReleases,
  NotFound,
  configuredReleaseSource,
} from "@cocalc/server/cli-distribution/releases";
import { getLogger } from "../../logger";

const logger = getLogger("hub:cli-distribution");
const IMMUTABLE = "public, max-age=31536000, immutable";

export default function initCliDistribution(
  router: Router,
  opts: { releases?: CliReleases; origin?: () => Promise<string> } = {},
): void {
  let releases = opts.releases;
  const getReleases = (): CliReleases | undefined => {
    if (releases == null) {
      const source = configuredReleaseSource();
      if (source != null) releases = new CliReleases(source);
    }
    return releases;
  };
  const origin =
    opts.origin ??
    (async () => new URL(await siteURL()).href.replace(/\/+$/, ""));

  const handle =
    (fn: (r: CliReleases, req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      const r = getReleases();
      if (r == null) {
        res
          .status(404)
          .type("text/plain")
          .send("This site does not serve the CoCalc CLI.\n");
        return;
      }
      try {
        await fn(r, req, res);
      } catch (err) {
        if (err instanceof NotFound) {
          res.status(404).type("text/plain").send(`${err.message}\n`);
          return;
        }
        logger.warn("cli distribution error", { url: req.url, err: `${err}` });
        if (!res.headersSent) {
          res
            .status(502)
            .type("text/plain")
            .send("The CLI release store is unavailable; try again.\n");
        }
      }
    };

  router.get(
    "/cli/site.json",
    handle(async (r, _req, res) => {
      res.set("Cache-Control", "public, max-age=30");
      // Exactly the canonical form clients require.
      res.type("application/json").send(JSON.stringify(await r.site()));
    }),
  );

  router.get(
    "/cli/install.sh",
    handle(async (r, _req, res) => {
      const site = await r.site();
      const { text, manifest } = await r.manifest(site.manifest);
      const script = installScript({
        origin: await origin(),
        manifestHash: site.manifest,
        manifestSize: Buffer.byteLength(text),
        manifest,
      });
      res.set("Cache-Control", "public, max-age=60");
      res.type("text/plain; charset=utf-8").send(script);
    }),
  );

  router.get(
    "/cli/manifests/:name",
    handle(async (r, req, res) => {
      const match = /^([0-9a-f]{64})\.json$/.exec(`${req.params.name}`);
      if (match == null) throw new NotFound("bad manifest name");
      const { text } = await r.manifest(match[1]);
      res.set("Cache-Control", IMMUTABLE);
      res.type("application/json").send(text);
    }),
  );

  router.get(
    "/cli/files/:manifest/:file",
    handle(async (r, req, res) => {
      // Served from the very handle whose bytes were verified.
      const { handle, size } = await r.file(
        `${req.params.manifest}`,
        `${req.params.file}`,
      );
      try {
        res.set("Cache-Control", IMMUTABLE);
        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Length", `${size}`);
        await new Promise<void>((resolve, reject) => {
          const stream = handle.createReadStream({
            start: 0,
            autoClose: false,
          });
          stream.on("error", reject);
          res.on("close", resolve);
          stream.pipe(res);
        });
      } finally {
        await handle.close();
      }
    }),
  );
}
