import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const readAppFile = (name: string) => readFileSync(join(process.cwd(), "app", name), "utf8");

describe("create page layout", () => {
  it("never hides the supported file chips", () => {
    const dropzone = readAppFile("file-dropzone.tsx");
    const chipsRow = dropzone.split("\n").find((line) => line.includes("gap-y-1.5"));
    expect(chipsRow).toBeDefined();
    expect(chipsRow).not.toMatch(/hidden/);
  });

  it("frees vertical space by hiding the lead paragraph on small and short screens", () => {
    const page = readAppFile("page.tsx");
    const leadClasses = page.match(/const LEAD = "([^"]*)"/)?.[1] ?? "";
    expect(leadClasses).toContain("max-sm:hidden");
    expect(leadClasses).toContain("[@media(max-height:740px)]:hidden");
  });
});
