import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface StateMigrationResult {
  migrated: boolean;
  source: string;
  destination: string;
  reason: "migrated" | "source-missing" | "destination-exists" | "same-directory";
}

function syncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function copyPrivateFile(source: string, destination: string): void {
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  syncFile(destination);
}

/**
 * Clone durable state into a fresh directory and publish it with one directory
 * rename. The legacy directory is intentionally left untouched as rollback
 * evidence; lock files and logs are runtime artifacts and are not migrated.
 */
export function migrateLegacyState(
  sourceDirectory: string,
  destinationDirectory: string,
  at = new Date().toISOString(),
): StateMigrationResult {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (source === destination) {
    return { migrated: false, source, destination, reason: "same-directory" };
  }
  if (existsSync(destination)) {
    return { migrated: false, source, destination, reason: "destination-exists" };
  }
  const sourceState = join(source, "state.json");
  if (!existsSync(sourceState)) {
    return { migrated: false, source, destination, reason: "source-missing" };
  }
  // Byte-identical corruption is still corruption. Refuse to publish an
  // unreadable legacy state so the installer can restart the untouched old
  // service instead of presenting an apparently healthy empty tree.
  JSON.parse(readFileSync(sourceState, "utf8"));

  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = `${destination}.migrating-${process.pid}-${crypto.randomUUID()}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    chmodSync(staging, 0o700);
    copyPrivateFile(sourceState, join(staging, "state.json"));
    const sourceToken = join(source, "capability.token");
    if (existsSync(sourceToken)) copyPrivateFile(sourceToken, join(staging, "capability.token"));
    const marker = join(staging, "migration.json");
    writeFileSync(marker, `${JSON.stringify({ from: source, migratedAt: at }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(marker, 0o600);
    syncFile(marker);

    // Read both copies before publication so an incomplete copy can never
    // become the canonical state directory.
    if (readFileSync(sourceState).compare(readFileSync(join(staging, "state.json"))) !== 0) {
      throw new Error("legacy state copy verification failed");
    }
    renameSync(staging, destination);
    chmodSync(destination, 0o700);
    try {
      const parentDescriptor = openSync(parent, "r");
      fsyncSync(parentDescriptor);
      closeSync(parentDescriptor);
    } catch {}
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  return { migrated: true, source, destination, reason: "migrated" };
}
