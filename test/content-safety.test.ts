import { describe, it, expect } from "vitest";
import {
  validateContent,
  ContentSafetyError,
  MAX_SIZE,
} from "../lib/content-safety";

// Minimal but real PNG: 8-byte signature + IHDR chunk start (enough for sniffing).
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR"),
  Buffer.alloc(16),
]);

// Minimal ZIP local-file-header signature (PK\x03\x04), enough for sniffing.
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26)]);

describe("content-safety", () => {
  it("rejects content larger than the 25MB limit with status 413", async () => {
    const big = Buffer.alloc(MAX_SIZE + 1);
    await expect(
      validateContent({ kind: "file", buffer: big, declaredMime: "image/png" }),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("accepts a PNG whose magic bytes match the declared type", async () => {
    await expect(
      validateContent({ kind: "file", buffer: PNG, declaredMime: "image/png" }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the declared type does not match the magic bytes (415)", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: PNG,
        declaredMime: "application/pdf",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects a blocked executable file extension (415)", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: Buffer.from("plain text content"),
        declaredMime: "text/plain",
        filename: "malware.exe",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects undetectable binary declared as a non-text type (415)", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]),
        declaredMime: "application/octet-stream",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("accepts a detectable type declared as the generic octet-stream", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: PNG,
        declaredMime: "application/octet-stream",
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a zip declared with the browser alias application/x-zip-compressed", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: ZIP,
        declaredMime: "application/x-zip-compressed",
        filename: "archive.zip",
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks a dangerous extension even when it is not the last segment (415)", async () => {
    await expect(
      validateContent({
        kind: "file",
        buffer: Buffer.from("plain text content"),
        declaredMime: "text/plain",
        filename: "evil.php.txt",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("accepts plain text content for the text kind", async () => {
    await expect(
      validateContent({
        kind: "text",
        buffer: Buffer.from("hello world"),
        declaredMime: "text/plain",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects infected content reported by the scanner with status 422", async () => {
    const scan = async () => ({ infected: true, signature: "Eicar-Test" });
    await expect(
      validateContent(
        { kind: "file", buffer: PNG, declaredMime: "image/png" },
        scan,
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("ContentSafetyError carries a code and an http status", () => {
    const e = new ContentSafetyError("too big", 413, "TOO_LARGE");
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(413);
    expect(e.code).toBe("TOO_LARGE");
  });
});
