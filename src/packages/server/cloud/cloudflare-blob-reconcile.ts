import { randomUUID } from "node:crypto";
import { sha256Hex, signR2Request } from "@cocalc/backend/r2";
import type { R2ObjectStoreAuth, R2RequestMethod } from "@cocalc/backend/r2";
import { blobWorkerSource } from "./cloudflare-blob-worker-source";
import { assertManagedBlobEnvironment } from "./cloudflare-blob-preflight";

export interface CloudflareBlobReconcileResult {
  ok: boolean;
  bucket?: string;
  worker?: string;
  public_url?: string;
  message?: string;
}

const TIMEOUT_MS = 15_000;
const API = "https://api.cloudflare.com/client/v4/";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
  "base64",
);
const clean = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

type Envelope<T> = {
  success: boolean;
  result: T;
  result_info?: { total_pages?: number };
};
type Domain = {
  hostname: string;
  service: string;
  zone_id: string;
  environment?: string;
};
type WorkerSettings = {
  tags?: string[];
  bindings?: { type: string; name: string; bucket_name?: string }[];
};

// Keep the deadline active through response-body consumption, not just headers.
async function request<T>(
  url: string,
  init: NonNullable<Parameters<typeof fetch>[1]>,
  consume: (response: Awaited<ReturnType<typeof fetch>>) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await consume(
      await fetch(url, {
        ...init,
        redirect: init.redirect ?? "error",
        signal: controller.signal,
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}

class ReconcileError extends Error {}

type ReconcileOptions = {
  settings: Record<string, any>;
  save: (values: Record<string, string>) => Promise<void>;
};

export function reconcileCloudflareBlobs(
  options: ReconcileOptions,
): Promise<CloudflareBlobReconcileResult>;
export function reconcileCloudflareBlobs(
  settings: Record<string, any>,
  save: ReconcileOptions["save"],
): Promise<CloudflareBlobReconcileResult>;
/** Site-wide operator reconciliation; never handles project or account traffic. */
export async function reconcileCloudflareBlobs(
  options: ReconcileOptions | Record<string, any>,
  saveCallback?: ReconcileOptions["save"],
): Promise<CloudflareBlobReconcileResult> {
  const { settings, save }: ReconcileOptions = saveCallback
    ? { settings: options, save: saveCallback }
    : (options as ReconcileOptions);
  let phase = "configuration validation";
  try {
    try {
      assertManagedBlobEnvironment();
    } catch (err) {
      throw new ReconcileError((err as Error).message);
    }
    const token = clean(settings.project_hosts_cloudflare_tunnel_api_token);
    const account = clean(settings.project_hosts_cloudflare_tunnel_account_id);
    const r2Account = clean(settings.r2_account_id) || account;
    const domain = clean(settings.dns).toLowerCase().replace(/\.$/, "");
    const prefix = clean(settings.r2_bucket_prefix);
    const bucket = clean(settings.blob_r2_bucket) || `${prefix}-blobs`;
    const worker = `${prefix}-blob-images`;
    const hostname = `blobs.${domain}`;
    const public_url = `https://${hostname}`;
    if (
      clean(settings.blob_r2_public_url) &&
      clean(settings.blob_r2_public_url).replace(/\/+$/, "") !== public_url
    ) {
      throw new ReconcileError(
        "The saved blob public URL differs from this domain. This wizard does not migrate blob domains or buckets. Keep the original target configured until an explicit migration is planned.",
      );
    }
    const accessKey = clean(settings.r2_access_key_id);
    const secretKey = clean(settings.r2_secret_access_key);
    if (
      !token ||
      !/^[a-f0-9]{32}$/i.test(account) ||
      r2Account !== account ||
      !accessKey ||
      !secretKey ||
      !/^[a-z0-9][a-z0-9-]{0,49}$/.test(prefix) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
      hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    ) {
      throw new ReconcileError(
        "Blob setup requires a domain, resource prefix, saved Cloudflare token/account, and matching R2 S3 credentials.",
      );
    }
    const root = `accounts/${account}`;
    const bucketPath = `${root}/r2/buckets/${bucket}`;
    const scriptPath = `${root}/workers/scripts/${worker}`;
    // Resource-side ownership survives a deployment succeeding before save fails.
    const owner = `cocalc-blobs-${sha256Hex(`${account}/${domain}/${bucket}`)}`;
    async function api<T>(
      path: string,
      method = "GET",
      body?: Record<string, unknown> | FormData,
      allowMissing = false,
    ): Promise<Envelope<T> | undefined> {
      return await request(
        API + path,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body instanceof FormData
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body:
            body instanceof FormData
              ? body
              : body
                ? JSON.stringify(body)
                : undefined,
        },
        async (response) => {
          if (allowMissing && response.status === 404) return undefined;
          if (!response.ok) throw new Error("Cloudflare request failed");
          const payload = (await response.json()) as Envelope<T>;
          if (payload.success !== true || payload.result == null)
            throw new Error("Invalid Cloudflare response");
          return payload;
        },
      );
    }
    async function list<T>(path: string): Promise<T[]> {
      const result: T[] = [];
      for (let page = 1; page <= 100; page++) {
        const payload = await api<T[]>(
          `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=50`,
        );
        if (!Array.isArray(payload?.result)) throw new Error("Invalid list");
        result.push(...payload.result);
        if (page >= (payload.result_info?.total_pages ?? 1)) return result;
      }
      throw new Error("Cloudflare list too large");
    }
    phase = "zone lookup";
    let zoneId: string | undefined;
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const zones = await list<{
        id: string;
        name: string;
        account: { id: string };
      }>(`zones?name=${name}&account.id=${account}`);
      zoneId = zones.find(
        (zone) => zone.name === name && zone.account?.id === account,
      )?.id;
      if (zoneId) break;
    }
    if (!zoneId || !/^[a-f0-9]{32}$/i.test(zoneId))
      throw new ReconcileError(
        "No matching Cloudflare zone in the configured account.",
      );

    phase = "Worker ownership check";
    const existing = (
      await api<WorkerSettings>(
        `${scriptPath}/settings`,
        "GET",
        undefined,
        true,
      )
    )?.result;
    if (
      existing &&
      (!existing.tags?.includes(owner) ||
        !existing.bindings?.some(
          (b) =>
            b.type === "r2_bucket" &&
            b.name === "BLOBS" &&
            b.bucket_name === bucket,
        ))
    ) {
      throw new ReconcileError(
        "Blob Worker ownership or bucket binding does not match this target. This wizard does not migrate blob domains or buckets and will not overwrite the existing Worker. Restore the original target or plan an explicit migration.",
      );
    }
    phase = "hostname ownership check";
    const domains = await list<Domain>(
      `${root}/workers/domains?hostname=${hostname}`,
    );
    const attached = domains.filter(
      (d) => d.hostname.toLowerCase() === hostname,
    );
    if (
      attached.some(
        (d) =>
          !existing ||
          d.service !== worker ||
          d.zone_id !== zoneId ||
          (d.environment && d.environment !== "production"),
      )
    ) {
      throw new ReconcileError(
        "Blob hostname is already attached to another Worker.",
      );
    }
    if (!attached.length) {
      phase = "DNS collision check";
      const records = await list<unknown>(
        `zones/${zoneId}/dns_records?name=${hostname}`,
      );
      if (records.length)
        throw new ReconcileError(
          "Blob hostname already has DNS records; refusing to replace them.",
        );
    }

    phase = "bucket provisioning";
    if (!(await api(bucketPath, "GET", undefined, true))) {
      await api(`${root}/r2/buckets`, "POST", {
        name: bucket,
        storage_class: "Standard",
      });
    }
    phase = "bucket privacy check";
    const managed = (await api<{ enabled: boolean }>(
      `${bucketPath}/domains/managed`,
    ))!.result;
    if (managed.enabled !== false) {
      await api(`${bucketPath}/domains/managed`, "PUT", { enabled: false });
      if (
        (await api<{ enabled: boolean }>(`${bucketPath}/domains/managed`))!
          .result.enabled !== false
      )
        throw new Error("Bucket remains public");
    }
    const custom = (await api<{ domains: { enabled: boolean }[] }>(
      `${bucketPath}/domains/custom`,
    ))!.result;
    if (
      !Array.isArray(custom.domains) ||
      custom.domains.some((d) => d.enabled !== false)
    ) {
      throw new ReconcileError(
        "Blob bucket has unexpected public custom-domain access; disable it before retrying.",
      );
    }

    phase = "Worker deployment";
    const upload = new FormData();
    upload.set(
      "metadata",
      new Blob(
        [
          JSON.stringify({
            main_module: "worker.mjs",
            compatibility_date: "2026-07-18",
            tags: [owner],
            bindings: [
              { type: "r2_bucket", name: "BLOBS", bucket_name: bucket },
            ],
          }),
        ],
        { type: "application/json" },
      ),
    );
    upload.set(
      "worker.mjs",
      new Blob([blobWorkerSource], { type: "application/javascript+module" }),
      "worker.mjs",
    );
    await api(scriptPath, "PUT", upload);
    if (!attached.length) {
      phase = "hostname attachment";
      await api(`${root}/workers/domains`, "PUT", {
        hostname,
        service: worker,
        zone_id: zoneId,
        environment: "production",
      });
    }

    let message =
      "Cloudflare blobs are healthy; same-origin redirect confirmed.";
    await probe(
      {
        endpoint: `https://${account}.r2.cloudflarestorage.com`,
        bucket,
        accessKey,
        secretKey,
      },
      public_url,
      (value) => {
        phase = value;
      },
      async (uuid) => {
        phase = "settings save";
        await save({
          blob_r2_bucket: bucket,
          blob_r2_public_url: public_url,
          blob_storage_backend: "auto",
        });
        // The hub may still have the previous settings cached. This check is
        // advisory: private S3 and public Worker health already passed.
        try {
          const confirmed = await request(
            `https://${domain}/blobs/cloudflare-probe.png?uuid=${uuid}`,
            { method: "HEAD", redirect: "manual" },
            async (response) =>
              response.status === 302 &&
              response.headers.get("location") === `${public_url}/${uuid}`,
          );
          if (!confirmed) throw new Error("Redirect not yet confirmed");
        } catch {
          message =
            "Cloudflare blobs are healthy and settings were saved. Same-origin redirect confirmation is pending; cached settings may take time to refresh. Retry reconciliation to confirm.";
        }
      },
    );
    return { ok: true, bucket, worker, public_url, message };
  } catch (err) {
    // Never reflect upstream response bodies, URLs, credentials, or callback errors.
    return {
      ok: false,
      message:
        err instanceof ReconcileError
          ? err.message
          : `Cloudflare blob setup failed during ${phase}. Check permissions and connectivity, then retry with the saved credentials.`,
    };
  }
}

async function probe(
  auth: R2ObjectStoreAuth,
  publicUrl: string,
  setPhase: (phase: string) => void,
  onHealthy: (uuid: string) => Promise<void>,
): Promise<void> {
  // A unique disposable id avoids overwriting/deleting a real content-addressed image.
  const uuid = randomUUID();
  const key = `blobs/v1/${uuid.slice(0, 2)}/${uuid}`;
  async function s3(method: R2RequestMethod): Promise<Buffer> {
    const body = method === "PUT" ? PNG : undefined;
    const signed = signR2Request({
      auth,
      method,
      key,
      payloadSha256: sha256Hex(body ?? ""),
      extraHeaders: body
        ? { "content-type": "image/png", "cache-control": "no-store" }
        : {},
    });
    return await request(
      signed.url,
      { method, headers: signed.headers, body },
      async (response) => {
        if (!response.ok) throw new Error("S3 probe failed");
        return Buffer.from(await response.arrayBuffer());
      },
    );
  }
  async function cleanupProbe(): Promise<void> {
    try {
      await s3("DELETE");
    } catch (err) {
      setPhase("probe cleanup");
      throw err;
    }
  }
  try {
    setPhase("S3 write probe");
    await s3("PUT");
    setPhase("S3 read probe");
    if (!(await s3("GET")).equals(PNG)) throw new Error("S3 bytes differ");
    for (const method of ["GET", "HEAD"]) {
      setPhase(`Worker ${method} probe`);
      await request(
        `${publicUrl}/${uuid}`,
        { method, headers: { "Cache-Control": "no-cache" } },
        async (response) => {
          if (
            response.status !== 200 ||
            response.headers.get("content-type") !== "image/png" ||
            response.headers.get("etag") !== `"${uuid}"` ||
            response.headers.get("x-content-type-options") !== "nosniff"
          )
            throw new Error("Worker probe failed");
          const bytes = Buffer.from(await response.arrayBuffer());
          if (method === "GET" ? !bytes.equals(PNG) : bytes.length !== 0)
            throw new Error("Worker bytes differ");
        },
      );
    }
    await onHealthy(uuid);
  } finally {
    await cleanupProbe();
  }
}
