import CemeteryViewer, { type ViewerConfig } from "../components/CemeteryViewer";

const DEFAULT_CESIUM_SCRIPT_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Cesium.js";

function publicFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === "true";
}

function publicText(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export default function HomePage() {
  const config: ViewerConfig = {
    boundaryUrl: publicText("NEXT_PUBLIC_BOUNDARY_URL", "/cemetery-boundary.geojson"),
    metricTilesetUrl: process.env.NEXT_PUBLIC_METRIC_TILESET_URL?.trim() || "",
    cesiumScriptUrl: publicText(
      "NEXT_PUBLIC_CESIUM_SCRIPT_URL",
      DEFAULT_CESIUM_SCRIPT_URL
    ),
    releaseId: publicText(
      "NEXT_PUBLIC_RELEASE_ID",
      "preview-no-public-release"
    ),
    modelStatusLabel: publicText(
      "NEXT_PUBLIC_MODEL_STATUS",
      "Awaiting reviewed public metric release"
    ),
    captureDate: publicText("NEXT_PUBLIC_CAPTURE_DATE", "2026-07-29"),
    publicReleaseApproved: publicFlag("NEXT_PUBLIC_PUBLIC_RELEASE_APPROVED"),
    privacyCropVerified: publicFlag("NEXT_PUBLIC_PRIVACY_CROP_VERIFIED")
  };

  return <CemeteryViewer config={config} />;
}

