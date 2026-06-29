import { describe, it, expect } from "vitest";
import { frameChunk, parseClamdReply } from "../lib/clamav";

describe("clamav INSTREAM helpers", () => {
  it("prefixes a chunk with its 4-byte big-endian length", () => {
    const framed = frameChunk(Buffer.from("abc"));
    expect(framed.length).toBe(7);
    expect(framed.readUInt32BE(0)).toBe(3);
    expect(framed.subarray(4).toString()).toBe("abc");
  });

  it("parses a clean reply", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ infected: false });
  });

  it("parses an infected reply and extracts the signature", () => {
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      infected: true,
      signature: "Eicar-Test-Signature",
    });
  });
});
