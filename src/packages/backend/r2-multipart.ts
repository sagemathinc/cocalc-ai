/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createReadStream } from "node:fs";
import { type R2ObjectStoreAuth, sendR2Request } from "./r2";

type MultipartAuth = R2ObjectStoreAuth & {
  key: string;
};

type UploadPartInput = MultipartAuth & {
  uploadId: string;
  partNumber: number;
  filePath: string;
  start: number;
  endInclusive: number;
};

function xmlTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, "i").exec(xml);
  return match?.[1]?.trim();
}

async function requestText({
  auth,
  method,
  query,
  payload = "",
  extraHeaders = {},
}: {
  auth: MultipartAuth;
  method: "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  payload?: Buffer | string;
  extraHeaders?: Record<string, string | number | undefined>;
}): Promise<{
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  const bodyBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const response = await sendR2Request({
    auth,
    method,
    key: auth.key,
    query,
    payload: bodyBuffer,
    extraHeaders: {
      ...extraHeaders,
      "content-length": bodyBuffer.length,
    },
    label: `R2 multipart ${method} ${auth.key}`,
  });
  return {
    statusCode: response.statusCode,
    body: response.body.toString("utf8"),
    headers: response.headers,
  };
}

export async function beginMultipartUpload(
  auth: MultipartAuth,
): Promise<{ uploadId: string }> {
  const response = await requestText({
    auth,
    method: "POST",
    query: { uploads: "" },
    payload: "",
    extraHeaders: { "content-type": "application/octet-stream" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart begin failed (${response.statusCode}): ${response.body}`,
    );
  }
  const uploadId = xmlTag(response.body, "UploadId");
  if (!uploadId) {
    throw new Error("R2 multipart begin response did not include UploadId");
  }
  return { uploadId };
}

export async function uploadMultipartPartFromFile(
  input: UploadPartInput,
): Promise<{ partNumber: number; etag: string }> {
  const partSize = input.endInclusive - input.start + 1;
  if (partSize <= 0) {
    throw new Error("multipart part size must be positive");
  }
  const response = await sendR2Request({
    auth: input,
    method: "PUT",
    key: input.key,
    query: {
      partNumber: input.partNumber,
      uploadId: input.uploadId,
    },
    payloadSha256: "UNSIGNED-PAYLOAD",
    createBodyStream: () =>
      createReadStream(input.filePath, {
        start: input.start,
        end: input.endInclusive,
      }),
    extraHeaders: {
      "content-length": partSize,
    },
    label: `R2 multipart PUT ${input.partNumber}`,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart upload part ${input.partNumber} failed (${response.statusCode}): ${response.body.toString("utf8")}`,
    );
  }
  const etagHeader = response.headers.etag;
  const etag = Array.isArray(etagHeader) ? etagHeader[0] : etagHeader;
  if (!etag) {
    throw new Error(
      `R2 multipart upload part ${input.partNumber} did not return ETag`,
    );
  }
  return {
    partNumber: input.partNumber,
    etag: etag.replace(/^"+|"+$/g, ""),
  };
}

export async function completeMultipartUpload({
  auth,
  uploadId,
  parts,
}: {
  auth: MultipartAuth;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  const body = [
    "<CompleteMultipartUpload>",
    ...parts
      .slice()
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(
        ({ partNumber, etag }) =>
          `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${etag}"</ETag></Part>`,
      ),
    "</CompleteMultipartUpload>",
  ].join("");
  const response = await requestText({
    auth,
    method: "POST",
    query: { uploadId },
    payload: body,
    extraHeaders: { "content-type": "application/xml" },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart complete failed (${response.statusCode}): ${response.body}`,
    );
  }
}

export async function abortMultipartUpload({
  auth,
  uploadId,
}: {
  auth: MultipartAuth;
  uploadId: string;
}): Promise<void> {
  const response = await requestText({
    auth,
    method: "DELETE",
    query: { uploadId },
    payload: "",
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `R2 multipart abort failed (${response.statusCode}): ${response.body}`,
    );
  }
}
