import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Share App",
  description: "Condivisione sicura di file e testo con link monouso cifrati.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body className="bg-zinc-100 text-zinc-900 antialiased">{children}</body>
    </html>
  );
}
