export type SourceStatus = "VERIFIED" | "QUARANTINED" | "BLOCKED_SOURCE";

export interface SourceManifest {
  schemaVersion: "1";
  sourceId: string;
  sourceVersion: string;
  uri: string;
  usageRights: { verified: boolean; basis: string };
  checksum: { algorithm: "sha256"; value: string };
  scope: readonly string[];
  lineage: readonly string[];
}

export interface LearningPackage<T = unknown> {
  schemaVersion: "1";
  packageId: string;
  manifest: SourceManifest;
  payload: T;
  status: SourceStatus;
  quarantineReason?: string;
}

export interface IntakeResult<T> {
  accepted: boolean;
  package: LearningPackage<T>;
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function quarantined<T>(manifest: SourceManifest, payload: T, reason: string): IntakeResult<T> {
  return {
    accepted: false,
    package: {
      schemaVersion: "1",
      packageId: manifest.sourceId + "@" + manifest.sourceVersion,
      manifest,
      payload,
      status: reason === "USAGE_RIGHTS_UNVERIFIED" ? "BLOCKED_SOURCE" : "QUARANTINED",
      quarantineReason: reason
    }
  };
}

export async function intakeLearningPackage<T>(
  manifest: SourceManifest,
  payload: T,
  canonicalBytes: string | Uint8Array
): Promise<IntakeResult<T>> {
  if (!manifest.sourceId || !manifest.sourceVersion || !manifest.uri) {
    return quarantined(manifest, payload, "MISSING_SOURCE_IDENTITY");
  }
  if (!manifest.usageRights.verified || !manifest.usageRights.basis.trim()) {
    return quarantined(manifest, payload, "USAGE_RIGHTS_UNVERIFIED");
  }
  if (manifest.checksum.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(manifest.checksum.value)) {
    return quarantined(manifest, payload, "INVALID_CHECKSUM");
  }
  const actual = await sha256Hex(canonicalBytes);
  if (actual.toLowerCase() !== manifest.checksum.value.toLowerCase()) {
    return quarantined(manifest, payload, "CHECKSUM_MISMATCH");
  }
  if (manifest.scope.length === 0) {
    return quarantined(manifest, payload, "EMPTY_SCOPE");
  }
  return {
    accepted: true,
    package: {
      schemaVersion: "1",
      packageId: manifest.sourceId + "@" + manifest.sourceVersion,
      manifest,
      payload,
      status: "VERIFIED"
    }
  };
}

export * from "./trajectory.js";
