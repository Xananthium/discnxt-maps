import CemeteryViewer, { type ViewerConfig } from "../components/CemeteryViewer";
import { parsePublicMapEpochs } from "../lib/mapEpochs.mjs";

const DEFAULT_CESIUM_SCRIPT_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Cesium.js";

function publicText(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export default function HomePage() {
  const config: ViewerConfig = {
    boundaryUrl: publicText("NEXT_PUBLIC_BOUNDARY_URL", "/cemetery-boundary.geojson"),
    cesiumScriptUrl: publicText(
      "NEXT_PUBLIC_CESIUM_SCRIPT_URL",
      DEFAULT_CESIUM_SCRIPT_URL
    ),
    epochs: parsePublicMapEpochs(process.env.NEXT_PUBLIC_MAP_EPOCHS_JSON)
  };

  return <CemeteryViewer config={config} />;
}
