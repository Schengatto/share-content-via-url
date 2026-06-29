import { describe, it, expect } from "vitest";
import {
  ACCEPT,
  MAX_SIZE,
  SUPPORTED_EXTS,
  SUPPORTED_MIMES,
  formatBytes,
  isSupportedFile,
} from "../lib/file-support";

/** Minimal File stand-in (jsdom-free): only the fields isSupportedFile reads. */
function fakeFile(name: string, type: string, size = 1): File {
  return { name, type, size } as File;
}

describe("file-support", () => {
  it("exposes the expected allowlisted MIME types", () => {
    expect(SUPPORTED_MIMES.has("image/png")).toBe(true);
    expect(SUPPORTED_MIMES.has("application/pdf")).toBe(true);
    expect(SUPPORTED_MIMES.has("text/csv")).toBe(true);
    expect(SUPPORTED_MIMES.has("application/x-msdownload")).toBe(false);
  });

  it("includes alternate extensions like jpeg", () => {
    expect(SUPPORTED_EXTS.has("jpg")).toBe(true);
    expect(SUPPORTED_EXTS.has("jpeg")).toBe(true);
  });

  it("ACCEPT lists both MIME types and dotted extensions", () => {
    expect(ACCEPT).toContain("image/png");
    expect(ACCEPT).toContain(".csv");
  });

  it("accepts a file by its MIME type", () => {
    expect(isSupportedFile(fakeFile("photo.png", "image/png"))).toBe(true);
  });

  it("accepts a CSV by extension when the browser reports no/odd MIME", () => {
    expect(isSupportedFile(fakeFile("data.csv", ""))).toBe(true);
  });

  it("rejects an unsupported type", () => {
    expect(isSupportedFile(fakeFile("app.exe", "application/x-msdownload"))).toBe(
      false,
    );
    expect(isSupportedFile(fakeFile("noext", ""))).toBe(false);
  });

  it("formats byte sizes for humans", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(MAX_SIZE)).toBe("25 MB");
  });
});
