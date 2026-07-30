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

test("public payload contains only reviewed map, attribution, and catalog artifacts", async () => {
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
    ".csv"
  ]);

  assert.deepEqual(
    files.map((path) => path.slice(publicRoot.length + 1)).sort(),
    [
      "catalog\\2026-07-29-v1\\catalog.json",
      "catalog\\2026-07-29-v1\\catalog.sqlite3",
      "cemetery-boundary.geojson",
      "third-party-notices.txt"
    ]
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

test("viewer fails closed and exposes compact Cesium spatial tools", async () => {
  const component = await readFile(
    join(viewerRoot, "components", "CemeteryViewer.tsx"),
    "utf8"
  );
  const page = await readFile(join(viewerRoot, "app", "page.tsx"), "utf8");
  const environment = await readFile(join(viewerRoot, ".env.example"), "utf8");
  const packageJson = JSON.parse(
    await readFile(join(viewerRoot, "package.json"), "utf8")
  );

  assert.match(component, /LAB · \{selectedEpoch\.captureDate\}/);
  assert.doesNotMatch(component, /Read before use/);
  assert.doesNotMatch(component, /GPS-scaled photogrammetry — not survey grade/);
  assert.match(component, /Cartesian3\.distance/);
  assert.match(component, /getPickRay\(windowPosition\)/);
  assert.match(component, /drillPickFromRay\(ray, 20\)/);
  assert.match(component, /belongsToTileset/);
  assert.match(component, /enableCollision: true/);
  assert.match(component, /Transforms\.eastNorthUpToFixedFrame/);
  assert.match(component, /lookAtTransform/);
  assert.match(component, /WALK_EYE_HEIGHT_M = 1\.7/);
  assert.match(component, /engineStatus !== "ready" \|\| !window\.Cesium/);
  assert.match(component, /requestPointerLock/);
  assert.match(component, /F walk\/fly/);
  assert.match(component, /Pick point/);
  assert.match(component, /Copy WGS84 \+ ECEF/);
  assert.match(component, /data-testid=\{metricReady \? "viewer-ready"/);
  assert.match(component, /FIXED_SCENE_TIME/);
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
  assert.match(component, /ND8\/ND16 filters[\s\S]*off/);
  assert.match(component, /5472 × 3648/);
  assert.match(
    component,
    /JPG[\s\S]*2 s route cadence[\s\S]*DNG\/JPG\+DNG[\s\S]*settled detail/
  );
  assert.match(component, /1\/1000 s target/);
  assert.match(component, /1\/800 s moving-flight/);
  assert.match(component, /f\/4[\s\S]*f\/2\.8/);
  assert.match(component, /Start ISO 100[\s\S]*cap at 400[\s\S]*800 only/);
  assert.match(component, /RTK[\s\S]*FIX[\s\S]*base\/NTRIP/);
  assert.match(
    component,
    /Highest canopy \+ terrain rise \+ 15 m[\s\S]*45 m \/ 148 ft[\s\S]*83\/80 overlap/
  );
  assert.match(component, /3 m\/s · 10\.8 km\/h max · 2 s/);
  assert.match(component, /Same verified safe altitude[\s\S]*−45° to −50°/);
  assert.match(component, /2\.5 m\/s · 9 km\/h · 2 s/);
  assert.match(component, /15–20 m above[\s\S]*10–15 m stand-off/);
  assert.match(component, /1 m\/s · 3\.6 km\/h/);
  assert.match(component, /Battery 1:[\s\S]*Batteries 2 and 3:[\s\S]*Recharge/);
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
  assert.match(
    component,
    /id: "north-oblique"[\s\S]*?height: 298[\s\S]*?range: 180/
  );
  assert.match(
    component,
    /id: "south-oblique"[\s\S]*?height: 298[\s\S]*?range: 180/
  );
  assert.match(
    component,
    /id: "east-edge"[\s\S]*?height: 298[\s\S]*?range: 180/
  );
  assert.match(component, /viewer\.camera\.lookAt\(/);
  assert.match(component, /useRef<BookmarkId>\("north-oblique"\)/);
  assert.match(component, /2026-07-29T18:00:00Z/);
  assert.match(environment, /releases\/1\.143\/Build\/Cesium\/Cesium\.js/);
});
