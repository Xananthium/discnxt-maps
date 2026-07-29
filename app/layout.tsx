import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const DEFAULT_CESIUM_BASE_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/";
const DEFAULT_CESIUM_CSS_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Widgets/widgets.css";

export const metadata: Metadata = {
  title: "Saint Martins Cemetery · Metric 3D Viewer",
  description:
    "A privacy-gated public viewer for a reviewed metric photogrammetry release."
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#071511",
  colorScheme: "dark"
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const cesiumBaseUrl =
    process.env.NEXT_PUBLIC_CESIUM_BASE_URL?.trim() || DEFAULT_CESIUM_BASE_URL;
  const cesiumCssUrl =
    process.env.NEXT_PUBLIC_CESIUM_WIDGETS_CSS_URL?.trim() || DEFAULT_CESIUM_CSS_URL;
  const serializedBaseUrl = JSON.stringify(cesiumBaseUrl).replaceAll("<", "\\u003c");

  return (
    <html lang="en">
      <head>
        <link rel="stylesheet" href={cesiumCssUrl} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.CESIUM_BASE_URL=${serializedBaseUrl};`
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

