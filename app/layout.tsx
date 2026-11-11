import type { Metadata, Viewport } from "next";
import BottomNav from "@/components/BottomNav";
import ScrollArea from "@/components/ScrollArea";
import "./globals.css";

export const metadata: Metadata = {
  title: "OPSELL",
  description: "AI-assisted option-selling strategy tool for NSE F&O stocks",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "OPSELL",
  },
  icons: {
    apple: "/icons/icon-180.png",
    icon: "/icons/icon-192.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell safe-top">
          <ScrollArea>{children}</ScrollArea>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
