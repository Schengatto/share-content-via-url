export interface PayloadMetadata {
  filename: string | null;
  mime: string;
}

export interface OpenedPayload extends PayloadMetadata {
  content: Buffer;
}

const HEADER_LENGTH_BYTES = 4;

export function sealPayload(metadata: PayloadMetadata, content: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify({ filename: metadata.filename, mime: metadata.mime }), "utf8");
  const headerLength = Buffer.alloc(HEADER_LENGTH_BYTES);
  headerLength.writeUInt32BE(header.length);
  return Buffer.concat([headerLength, header, content]);
}

export function openPayload(payload: Buffer): OpenedPayload {
  const headerEnd = HEADER_LENGTH_BYTES + payload.readUInt32BE(0);
  const metadata = JSON.parse(payload.subarray(HEADER_LENGTH_BYTES, headerEnd).toString("utf8")) as PayloadMetadata;
  return { filename: metadata.filename, mime: metadata.mime, content: payload.subarray(headerEnd) };
}
