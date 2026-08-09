import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";

const font = IBM_Plex_Sans_Arabic({
  subsets: ["arabic"],
  weight: ["400", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "لملم — تجهيز",
  description: "امسح الباركود، شوف المنتجات، سجّل التعبئة.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "لملم" },
};

export const viewport: Viewport = {
  themeColor: "#0E0F11",
  width: "device-width",
  initialScale: 1,
  // Locked: this is a one-handed tool and a stray pinch mid-scan is a nuisance.
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl" className={font.className}>
      <body>{children}</body>
    </html>
  );
}
