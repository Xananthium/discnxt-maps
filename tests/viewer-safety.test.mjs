import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const viewerRoot = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(viewerRoot, "public");

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    })
  );
  return nested.flat();
}

test("public payload contains no source imagery or private capture artifacts", async () => {
  const files = await filesUnder(publicRoot);
  const forbiddenExtensions = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".tif",
    ".tiff",
    ".dng",
    ".raw",
    ".exif",
    ".xmp",
    ".gpx",
    ".kml",
    ".kmz",
    ".db",
    ".sqlite",
    ".csv"
  ]);

  assert.deepEqual(
    files.map((path) => path.slice(publicRoot.length + 1)).sort(),
    ["cemetery-boundary.geojson", "third-party-notices.txt"]
  );
  for (const path of files) {
    assert.equal(
      forbiddenExtensions.has(extname(path).toLowerCase()),
      false,
      `forbidden public artifact: ${path}`
    );
  }
});

test("boundary is a closed, attributed OSM polygon with a legal-boundary warning", async () => {
  const path = join(publicRoot, "cemetery-boundary.geojson");
  const boundary = JSON.parse(await readFile(path, "utf8"));
  const feature = boundary.features[0];
  const ring = feature.geometry.coordinates[0];

  assert.equal(boundary.type, "FeatureCollection");
  assert.equal(feature.geometry.type, "Polygon");
  assert.ok(ring.length >= 4);
  assert.deepEqual(ring.at(0), ring.at(-1));
  assert.match(feature.properties.attribution, /OpenStreetMap contributors/);
  assert.match(feature.properties.license, /ODbL/);
  assert.match(feature.properties.disclaimer, /not proof of a legal parcel boundary/i);
});

test("public notices retain runtime and map-data license attribution", async () => {
  const notices = await readFile(
    join(publicRoot, "third-party-notices.txt"),
    "utf8"
  );

  assert.match(notices, /CesiumJS 1\.143/);
  assert.match(notices, /Apache License 2\.0/);
  assert.match(notices, /Next\.js 16\.2\.12/);
  assert.match(notices, /React and React DOM 19\.2\.8/);
  assert.match(notices, /OpenStreetMap contributors/);
  assert.match(notices, /Open Database License 1\.0/);
});

test("viewer fails closed and exposes metric authority plus disclosures", async () => {
  const component = await readFile(
    join(viewerRoot, "components", "CemeteryViewer.tsx"),
    "utf8"
  );
  const page = await readFile(join(viewerRoot, "app", "page.tsx"), "utf8");
  const environment = await readFile(join(viewerRoot, ".env.example"), "utf8");
  const packageJson = JSON.parse(
    await readFile(join(viewerRoot, "package.json"), "utf8")
  );

  assert.match(component, /GPS-scaled photogrammetry — not survey grade/);
  assert.match(component, /Cartesian3\.distance/);
  assert.match(component, /pickPosition/);
  assert.match(component, /belongsToTileset/);
  assert.match(component, /requestPointerLock/);
  assert.match(component, /data-testid=\{metricReady \? "viewer-ready"/);
  assert.match(component, /Browser clipping is not a privacy/);
  assert.match(component, /FIXED_SCENE_TIME/);
  assert.match(component, /median stated GNSS accuracies of 0\.847 m/);
  assert.match(component, /average[\s\S]*GNSS-prior[\s\S]*3\.125 m/);
  assert.match(component, /Absolute accuracy: unvalidated/);
  assert.match(component, /physically cropped public derivative/);
  assert.match(component, /source[\s\S]*photographs[\s\S]*not published/);
  assert.match(component, /contentAttribution/);
  assert.match(component, /contentLicenseUrl/);
  assert.match(component, /third-party-notices\.txt/);
  assert.match(component, /data-release-id=\{selectedEpoch\.releaseId\}/);
  assert.match(component, /data-model-status=\{modelStatus\}/);
  assert.match(page, /NEXT_PUBLIC_MAP_EPOCHS_JSON/);
  assert.doesNotMatch(page, /NEXT_PUBLIC_METRIC_TILESET_URL/);
  assert.match(environment, /"id":"2026-07-29"/);
  assert.match(environment, /"metricTilesetUrl":""/);
  assert.match(environment, /"contentAttribution":""/);
  assert.match(environment, /"contentLicense":""/);
  assert.match(environment, /"contentLicenseUrl":""/);
  assert.match(environment, /"publicReleaseApproved":false/);
  assert.match(environment, /"privacyCropVerified":false/);
  assert.equal("deploy" in packageJson.scripts, false);
});

test("timeline switches only the selected gated metric layer and carries URL state", async () => {
  const component = await readFile(
    join(viewerRoot, "components", "CemeteryViewer.tsx"),
    "utf8"
  );

  assert.match(component, /aria-label="Map timeline"/);
  assert.match(component, /aria-current=\{selected \? "date"/);
  assert.match(component, /url\.searchParams\.set\("epoch", nextEpochId\)/);
  assert.match(component, /selectedEpoch\.metricTilesetUrl/);
  assert.match(
    component,
    /selectedEpoch\.publicReleaseApproved && selectedEpoch\.privacyCropVerified/
  );
  assert.match(component, /removeTileset\(viewer, previousTileset\)/);
  assert.match(component, /data-map-epoch=\{selectedEpoch\.id\}/);
});

test("next-flight card exposes the measured Autel capture prescription", async () => {
  const component = await readFile(
    join(viewerRoot, "components", "CemeteryViewer.tsx"),
    "utf8"
  );

  assert.match(component, /<details className="next-flight-panel panel">/);
  assert.match(component, /Autel EVO II Pro Enterprise V3 RTK/);
  assert.match(component, /ND filters[\s\S]*off by default/);
  assert.match(component, /5472 × 3648/);
  assert.match(component, /JPG[\s\S]*2 s cadence[\s\S]*DNG[\s\S]*5 s/);
  assert.match(component, /1\/1000 s target/);
  assert.match(component, /1\/800 s moving-flight/);
  assert.match(component, /f\/4[\s\S]*f\/2\.8/);
  assert.match(component, /ISO 100–800/);
  assert.match(component, /RTK[\s\S]*FIX[\s\S]*base\/NTRIP/);
  assert.match(
    component,
    /30 m AGL · −90° nadir \+ four −45° to −50° oblique[\s\S]*83\/80 overlap/
  );
  assert.match(component, /1\.5 m\/s · 2 s/);
  assert.match(component, /10 m AGL · −25° · N\/S\/E\/W · ≤5 m line spacing/);
  assert.match(component, /1 m\/s · 2 s/);
  assert.match(component, /8–15 m stand-off · −10° to −25° · five azimuth offsets/);
  assert.match(component, /1–2 m stations/);
});

test("camera bookmarks and Cesium runtime are deterministic and pinned", async () => {
  const component = await readFile(
    join(viewerRoot, "components", "CemeteryViewer.tsx"),
    "utf8"
  );
  const environment = await readFile(join(viewerRoot, ".env.example"), "utf8");

  for (const bookmark of [
    "overview",
    "north-oblique",
    "south-oblique",
    "east-edge"
  ]) {
    assert.match(component, new RegExp(`id: "${bookmark}"`));
  }
  assert.match(component, /2026-07-29T18:00:00Z/);
  assert.match(environment, /releases\/1\.143\/Build\/Cesium\/Cesium\.js/);
});
