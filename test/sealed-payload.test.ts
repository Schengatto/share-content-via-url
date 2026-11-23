import { describe, it, expect } from "vitest";
import { openPayload, sealPayload } from "../lib/sealed-payload";

describe("sealed-payload", () => {
  it("round-trips filename, mime and binary content", () => {
    const content = Buffer.from([0, 1, 2, 255]);
    const sealed = sealPayload({ filename: "report-q4.pdf", mime: "application/pdf" }, content);
    expect(openPayload(sealed)).toEqual({ filename: "report-q4.pdf", mime: "application/pdf", content });
  });

  it("round-trips a text payload without filename", () => {
    const sealed = sealPayload({ filename: null, mime: "text/plain" }, Buffer.from("top secret"));
    const opened = openPayload(sealed);
    expect(opened.filename).toBeNull();
    expect(opened.mime).toBe("text/plain");
    expect(opened.content.toString()).toBe("top secret");
  });

  it("keeps a unicode filename intact", () => {
    const sealed = sealPayload({ filename: "città-€.txt", mime: "text/plain" }, Buffer.alloc(0));
    expect(openPayload(sealed).filename).toBe("città-€.txt");
  });
});
