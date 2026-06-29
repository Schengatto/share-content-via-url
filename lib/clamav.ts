import { connect } from "node:net";
import type { ScanResult } from "./content-safety";

/**
 * Minimal clamd INSTREAM client (no external dependency).
 *
 * Protocol: send `zINSTREAM\0`, then a sequence of chunks each prefixed by a
 * 4-byte big-endian length, terminated by a zero-length chunk. clamd replies
 * `stream: OK` or `stream: <Signature> FOUND`.
 */

/** Build the INSTREAM length-prefixed frame for a chunk (exported for testing). */
export function frameChunk(chunk: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(chunk.length, 0);
  return Buffer.concat([len, chunk]);
}

/** Parse a clamd INSTREAM reply into a ScanResult (exported for testing). */
export function parseClamdReply(reply: string): ScanResult {
  const text = reply.trim();
  if (/\bFOUND\b/.test(text)) {
    const match = text.match(/stream:\s+(.*)\s+FOUND/);
    return { infected: true, signature: match?.[1] ?? "unknown" };
  }
  return { infected: false };
}

export function scanWithClamd(buffer: Buffer): Promise<ScanResult> {
  const host = process.env.CLAMAV_HOST ?? "127.0.0.1";
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  const timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS ?? 10_000);

  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;

    // Always destroy the socket and settle exactly once, so a clamd that
    // connects but never replies can't leave the request hanging forever.
    const done = (err: Error | null, value?: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => done(new Error("clamd scan timed out")));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      socket.write(frameChunk(buffer));
      socket.write(Buffer.from([0, 0, 0, 0])); // zero-length terminator
    });
    socket.on("data", (d: Buffer) => chunks.push(d));
    socket.on("error", (err) => done(err));
    socket.on("end", () => {
      done(null, parseClamdReply(Buffer.concat(chunks).toString("utf8")));
    });
  });
}
