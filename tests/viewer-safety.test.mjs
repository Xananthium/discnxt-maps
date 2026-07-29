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
    files.map((path) => path.slice(publicRoot.length + 1)),
    ["cemetery-boundary.geojson"]
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
  assert.match(component, /average GNSS-prior[\s\S]*6\.703 m/);
  assert.match(page, /NEXT_PUBLIC_METRIC_TILESET_URL/);
  assert.match(page, /NEXT_PUBLIC_PUBLIC_RELEASE_APPROVED/);
  assert.match(page, /NEXT_PUBLIC_PRIVACY_CROP_VERIFIED/);
  assert.match(environment, /NEXT_PUBLIC_METRIC_TILESET_URL=\s*\n/);
  assert.equal("deploy" in packageJson.scripts, false);
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
