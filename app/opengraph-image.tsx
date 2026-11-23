import { ImageResponse } from "next/og";
import { AMBER, LockMark, NIGHT } from "./lock-mark";

export const alt = "share/secret: read once, then burned.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          background: `radial-gradient(circle at 85% 15%, #2a2314 0%, ${NIGHT} 55%)`,
          color: "#ecebe4",
          fontFamily: "monospace",
        }}
      >
        <LockMark size={140} />
        <div style={{ display: "flex", marginTop: 40, fontSize: 84, fontWeight: 600, letterSpacing: -2 }}>
          share<span style={{ color: AMBER }}>/</span>secret
        </div>
        <div style={{ display: "flex", marginTop: 20, fontSize: 40, color: "#8d8f86" }}>
          Read once, then burned.
        </div>
      </div>
    ),
    size,
  );
}
