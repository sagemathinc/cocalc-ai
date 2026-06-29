/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface ContentAddressedBlob {
  blob: string;
  uuid: string;
}

export async function blobToContentAddressedBase64(
  file: Blob,
): Promise<ContentAddressedBlob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    blob: bytesToBase64(bytes),
    uuid: await uuidSha1FromBytes(bytes),
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export async function uuidSha1FromBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", exactArrayBuffer(bytes));
  const sha1 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return uuidFromSha1Hex(sha1);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function uuidFromSha1Hex(sha1: string): string {
  let i = -1;
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    i += 1;
    if (c === "x") {
      return sha1[i] ?? "0";
    }
    return ((parseInt(`0x${sha1[i] ?? "0"}`, 16) & 0x3) | 0x8).toString(16);
  });
}
