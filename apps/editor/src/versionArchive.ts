/**
 * G-263 / VER export slice: portable, bounded, integrity-checked graph history.
 *
 * This is a read-only export/inspection boundary, NOT a cross-writer lock,
 * authenticated signature, database import, or rollback of external effects.
 * SHA-256 detects accidental corruption; it does not establish provenance.
 */
import {
  VersionStore,
  type VersionDocument,
  type VersionStorage,
} from "./versionStore";

export const MAX_VERSION_ARCHIVE_BYTES = 4 * 1024 * 1024;
const ARCHIVE_FORMAT = "hex.versionArchive.v1";

interface VersionArchive {
  format: typeof ARCHIVE_FORMAT;
  sha256: string;
  document: VersionDocument;
}

function fail(code: string): never {
  throw new Error(code);
}

function sizeOf(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

async function sha256(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) fail("ARCHIVE_CRYPTO_UNAVAILABLE");
  const bytes = new TextEncoder().encode(text);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Export the entire validated, project-scoped history as a deterministic JSON
 * bundle. The byte cap prevents exporting a huge localStorage history by
 * accident. No storage or external provider mutation occurs.
 */
export async function exportVersionArchive(store: VersionStore): Promise<string> {
  const document = store.load();
  const serialized = JSON.stringify(document);
  if (sizeOf(serialized) > MAX_VERSION_ARCHIVE_BYTES) {
    fail("ARCHIVE_TOO_LARGE");
  }
  const archive: VersionArchive = {
    format: ARCHIVE_FORMAT,
    sha256: await sha256(serialized),
    document,
  };
  const output = JSON.stringify(archive);
  if (sizeOf(output) > MAX_VERSION_ARCHIVE_BYTES) fail("ARCHIVE_TOO_LARGE");
  return output;
}

/**
 * Inspect an untrusted archive without writing to any project store. Verify
 * checksum, expected project identity, version DAG, graph uniqueness and
 * schema through VersionStore.load before returning a detached document.
 *
 * An actual import needs separate explicit user consent, serialized writer
 * ownership, backup and provider-atomic persistence; this function does none.
 */
export async function inspectVersionArchive(
  archiveJson: string,
  expectedProjectId: string,
): Promise<VersionDocument> {
  if (typeof archiveJson !== "string" ||
      sizeOf(archiveJson) > MAX_VERSION_ARCHIVE_BYTES) {
    fail("ARCHIVE_TOO_LARGE");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(archiveJson);
  } catch {
    fail("INVALID_ARCHIVE");
  }
  if (!decoded || typeof decoded !== "object") fail("INVALID_ARCHIVE");
  const archive = decoded as Partial<VersionArchive>;
  if (archive.format !== ARCHIVE_FORMAT ||
      typeof archive.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(archive.sha256) ||
      !archive.document || typeof archive.document !== "object") {
    fail("INVALID_ARCHIVE");
  }
  if (archive.document.projectId !== expectedProjectId) {
    fail("ARCHIVE_PROJECT_MISMATCH");
  }
  const serialized = JSON.stringify(archive.document);
  if (sizeOf(serialized) > MAX_VERSION_ARCHIVE_BYTES) fail("ARCHIVE_TOO_LARGE");
  if (await sha256(serialized) !== archive.sha256) {
    fail("ARCHIVE_INTEGRITY_FAILURE");
  }
  const readOnlyStorage: VersionStorage = {
    getItem: () => serialized,
    setItem: () => fail("ARCHIVE_READ_ONLY"),
  };
  return new VersionStore(readOnlyStorage, expectedProjectId).load();
}
