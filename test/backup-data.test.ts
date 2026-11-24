import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";
const bashPath = isWindows ? "C:/Program Files/Git/bin/bash.exe" : "bash";
const scriptPath = fileURLToPath(new URL("../deploy/backup-data.sh", import.meta.url));

function toBashPath(path: string): string {
  if (!isWindows) return path;
  return path.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, "/");
}

describe.skipIf(isWindows && !existsSync(bashPath))("deploy/backup-data.sh", { timeout: 120_000 }, () => {
  let root: string;
  let dataDir: string;
  let backupDir: string;

  function runBackupScript(...args: string[]) {
    return spawnSync(bashPath, [toBashPath(scriptPath), ...args], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: toBashPath(dataDir), BACKUP_DIR: toBashPath(backupDir) },
    });
  }

  function writeBackupFile(name: string, ageDays = 0) {
    const path = join(backupDir, name);
    writeFileSync(path, "old");
    const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    utimesSync(path, mtime, mtime);
  }

  function backupArchives() {
    return readdirSync(backupDir).filter((name) => name.startsWith("share-secret-data-"));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backup-data-"));
    dataDir = join(root, "data");
    backupDir = join(root, "backups");
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    mkdirSync(backupDir);
    writeFileSync(join(dataDir, "share.db"), "db");
    writeFileSync(join(dataDir, "blobs", "blob-1"), "ciphertext");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("archives the data directory and keeps only the new backup", () => {
    writeBackupFile("share-secret-data-pre-old-20260101T000000Z.tgz");
    writeBackupFile("unrelated.tgz");

    const result = runBackupScript("pre-shs8");

    expect(result.status).toBe(0);
    const archives = backupArchives();
    expect(archives).toHaveLength(1);
    expect(archives[0]).toMatch(/^share-secret-data-pre-shs8-\d{8}T\d{6}Z\.tgz$/);
    expect(existsSync(join(backupDir, "unrelated.tgz"))).toBe(true);

    const listing = spawnSync(bashPath, ["-c", `tar -tzf "${toBashPath(join(backupDir, archives[0]))}"`], {
      encoding: "utf8",
    });
    expect(listing.stdout.split("\n")).toEqual(expect.arrayContaining(["data/share.db", "data/blobs/blob-1"]));
  });

  it("succeeds when the archive listing is larger than a pipe buffer", () => {
    for (let index = 0; index < 1500; index++) {
      writeFileSync(join(dataDir, "blobs", `${String(index).padStart(4, "0")}-${"x".repeat(60)}`), "c");
    }

    const result = runBackupScript("pre-shs8");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(backupArchives()).toHaveLength(1);
  });

  it.skipIf(isWindows)("writes the archive readable by the owner only", () => {
    runBackupScript("pre-shs8");

    expect(statSync(join(backupDir, backupArchives()[0])).mode & 0o777).toBe(0o600);
  });

  it("refuses to back up a data directory without share.db and keeps existing backups", () => {
    rmSync(join(dataDir, "share.db"));
    writeBackupFile("share-secret-data-pre-old-20260101T000000Z.tgz");

    const result = runBackupScript("pre-shs8");

    expect(result.status).not.toBe(0);
    expect(backupArchives()).toEqual(["share-secret-data-pre-old-20260101T000000Z.tgz"]);
  });

  it("rejects a label with path characters", () => {
    const result = runBackupScript("../escape");

    expect(result.status).toBe(2);
    expect(backupArchives()).toEqual([]);
  });

  it("prunes backups older than seven days and keeps newer and unrelated files", () => {
    writeBackupFile("share-secret-data-pre-old-20260101T000000Z.tgz", 8);
    writeBackupFile("share-secret-data-pre-new-20260110T000000Z.tgz", 6);
    writeBackupFile("unrelated.tgz", 30);

    const result = runBackupScript("--prune");

    expect(result.status).toBe(0);
    expect(backupArchives()).toEqual(["share-secret-data-pre-new-20260110T000000Z.tgz"]);
    expect(existsSync(join(backupDir, "unrelated.tgz"))).toBe(true);
  });
});
