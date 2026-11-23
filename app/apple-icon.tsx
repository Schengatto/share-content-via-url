import { ImageResponse } from "next/og";
import { LockMark, NIGHT } from "./lock-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: NIGHT,
        }}
      >
        <LockMark size={150} />
      </div>
    ),
    size,
  );
}
