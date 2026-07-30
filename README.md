# Saint Martins Cemetery public viewer

This is a local, deployment-neutral Next.js/OpenNext prototype for the governed
public experience described in `../docs/PUBLIC_VIEWER_DESIGN.md`.

The checked-in default is deliberately a boundary-only preview. It does not
contain a public metric release, source photographs, metadata, camera paths, or
private capture data. The metric tileset is never requested unless all three of
these conditions are true for the currently selected map epoch:

1. Its `metricTilesetUrl` names a reviewed metric Cesium 3D Tiles release.
2. Its `publicReleaseApproved` value is the JSON boolean `true`.
3. Its `privacyCropVerified` value is the JSON boolean `true`.

Browser clipping is not accepted as a privacy control. Crop the released asset
physically before setting either gate.

## Local use

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

Open
`http://localhost:3000/?epoch=2026-07-29&bookmark=overview&quality=balanced`.
Camera bookmarks are deterministic, scene time is fixed, and no basemap imagery
is requested. The shell exposes `data-shell-ready="true"` after the OSM
boundary loads. `data-testid="viewer-ready"` appears only after the first
visible tile from the selected, approved epoch loads.

The four bookmark IDs are `overview`, `north-oblique`, `south-oblique`, and
`east-edge`; quality IDs are `lite`, `balanced`, and `ultra`.

## Immutable map epochs

`NEXT_PUBLIC_MAP_EPOCHS_JSON` is one browser-readable JSON array. It must retain
the `2026-07-29` baseline and use unique ISO capture dates and release IDs.
Treat it as append-only: publish a new, versioned tileset URL in a new object;
never replace the URL or identity of an older public epoch. The viewer orders
epochs by capture date, puts the selected ID in the `epoch` URL parameter, and
on selection removes the prior metric primitive before requesting only the
new epoch's asset.

Each entry has exactly these fields:

```json
{
  "id": "YYYY-MM-DD",
  "label": "Short public label",
  "captureDate": "YYYY-MM-DD",
  "releaseId": "unique-versioned-release-id",
  "modelStatusLabel": "Public status text.",
  "metricTilesetUrl": "https://assets.example/release-id/tileset.json",
  "publicReleaseApproved": false,
  "privacyCropVerified": false
}
```

`id` and `captureDate` must match. Asset URLs must be HTTPS or root-relative.
The parser rejects unknown fields, malformed dates/URLs, string-valued gates,
duplicate IDs, duplicate release IDs, and manifests without the baseline. Any
one invalid entry rejects the entire manifest and restores a locked,
boundary-only baseline; it never partially accepts an epoch list.

## Controls and authority

- Use the compact timeline to change dated map epochs. Held epochs remain
  selectable for disclosure but their tilesets are never requested.
- Use the preset buttons for repeatable views.
- Enter fly mode for pointer-lock navigation: WASD moves, Q/E moves vertically,
  the mouse looks, Shift accelerates, and Escape releases the pointer.
- Distance measurement accepts only picks whose Cesium feature belongs to the
  configured metric 3D Tiles object. It uses depth-derived ECEF positions and
  `Cartesian3.distance`, reported in metres.
- Camera coordinates are navigation readouts. They do not establish model or
  survey accuracy.
- Expand **Next flight** for the measured Autel EVO II Pro Enterprise V3 RTK
  capture prescription. It keeps ND filters off by default; fixes full
  5472 × 3648 3:2 capture, manual 1/1000 s target/1/800 s moving floor,
  f/4-to-f/2.8 and ISO 100–800 limits, fixed white balance/focus, RTK FIX,
  raw-observation retention, checkpoints, JPG/DNG cadence limits, and the
  global/detail/facade passes.

Always retain the visible warning: **GPS-scaled photogrammetry — not survey
grade**. Camera metadata's median stated GNSS accuracies (0.847 m horizontal,
2.597 m vertical) are not demonstrated reconstruction accuracy. Keep those
metadata values distinct from the selected triangulation reconstruction's
measured average GNSS-prior residual of 3.125 m; that residual also does not
establish survey accuracy.

## Asset and license contract

All browser asset locations are configurable in `.env.example`. Cross-origin
asset hosts must permit browser CORS requests. CesiumJS 1.143 is pinned to the
official Cesium CDN and is available under Apache-2.0; it may instead be mirrored
with its license notices intact.

`public/cemetery-boundary.geojson` is a reduced public copy of OSM way
541388870. It is © OpenStreetMap contributors and licensed under ODbL 1.0. It is
only a privacy-screening proxy, not proof of a legal parcel boundary, ownership,
access, authorization, or publication rights.

The viewer source is community software under the [MIT License](LICENSE).

## Verification and local OpenNext packaging

```powershell
npm test
npm run typecheck
npm run build
npm run build:opennext
```

The OpenNext configuration writes a local `.open-next/` artifact and includes
no deploy script, account identifier, route, DNS record, or server mutation.
