import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Share App",
  description: "Secure sharing of files and text through encrypted single-use links.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-zinc-100 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
