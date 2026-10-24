/**
 * G-263: read-only, project-scoped archive export from committed IndexedDB
 * history. The IDB read transaction provides a coherent local snapshot.
 *
 * The resulting SHA-256 bundle detects corruption, NOT forgery. Export does
 * not upload, back up, restore, or replay anything. IndexedDB may be evicted;
 * callers must separately save and verify the bundle on an independent
 * durable provider before claiming disaster-recovery readiness.
 */
import { exportVersionArchive, inspectVersionArchive } from "./versionArchive";
import { readIndexedDbHistory } from "./versionIndexedDb";
import { VersionStore, type VersionStorage } from "./versionStore";

/** Export the exact validated browser-local graph history without a write. */
export async function exportIndexedDbVersionArchive(
  databaseName: string,
  projectId: string,
): Promise<string> {
  const history = await readIndexedDbHistory(databaseName, projectId);
  const serialized = JSON.stringify(history);
  const readOnly: VersionStorage = {
    getItem: () => serialized,
    setItem: () => { throw new Error("ARCHIVE_EXPORT_READ_ONLY"); },
  };
  const archive = await exportVersionArchive(new VersionStore(readOnly, projectId));
  const checked = await inspectVersionArchive(archive, projectId);
  if (JSON.stringify(checked) !== serialized) {
    throw new Error("ARCHIVE_EXPORT_READBACK_MISMATCH");
  }
  return archive;
}
