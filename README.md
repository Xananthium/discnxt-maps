# Saint Martins Cemetery public viewer

This is a local, deployment-neutral Next.js/OpenNext prototype for the governed
public experience described in `../docs/PUBLIC_VIEWER_DESIGN.md`.

The checked-in default is deliberately a boundary-only preview. It does not
contain a public metric release, source photographs, metadata, camera paths, or
private capture data. The metric tileset is never requested unless all three of
these conditions are true:

1. `NEXT_PUBLIC_METRIC_TILESET_URL` names a reviewed metric Cesium 3D Tiles
   release.
2. `NEXT_PUBLIC_PUBLIC_RELEASE_APPROVED=true`.
3. `NEXT_PUBLIC_PRIVACY_CROP_VERIFIED=true`.

Browser clipping is not accepted as a privacy control. Crop the released asset
physically before setting either gate.

## Local use

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3000/?bookmark=overview&quality=balanced`. Camera
bookmarks are deterministic, scene time is fixed, and no basemap imagery is
requested. The shell exposes `data-shell-ready="true"` after the OSM boundary
loads. `data-testid="viewer-ready"` appears only after the first visible tile
from an approved metric tileset loads.

The four bookmark IDs are `overview`, `north-oblique`, `south-oblique`, and
`east-edge`; quality IDs are `lite`, `balanced`, and `ultra`.

## Controls and authority

- Use the preset buttons for repeatable views.
- Enter fly mode for pointer-lock navigation: WASD moves, Q/E moves vertically,
  the mouse looks, Shift accelerates, and Escape releases the pointer.
- Distance measurement accepts only picks whose Cesium feature belongs to the
  configured metric 3D Tiles object. It uses depth-derived ECEF positions and
  `Cartesian3.distance`, reported in metres.
- Camera coordinates are navigation readouts. They do not establish model or
  survey accuracy.

Always retain the visible warning: **GPS-scaled photogrammetry — not survey
grade**. Camera metadata's median stated GNSS accuracies (0.847 m horizontal,
2.597 m vertical) are not demonstrated reconstruction accuracy. Keep those
metadata values distinct from the incremental reconstruction's measured average
GNSS-prior residual of 6.703 m; that residual also does not establish survey
accuracy.

## Asset and license contract

All browser asset locations are configurable in `.env.example`. Cross-origin
asset hosts must permit browser CORS requests. CesiumJS 1.143 is pinned to the
official Cesium CDN and is available under Apache-2.0; it may instead be mirrored
with its license notices intact.

`public/cemetery-boundary.geojson` is a reduced public copy of OSM way
541388870. It is © OpenStreetMap contributors and licensed under ODbL 1.0. It is
only a privacy-screening proxy, not proof of a legal parcel boundary, ownership,
access, authorization, or publication rights.

## Verification and local OpenNext packaging

```powershell
npm test
npm run typecheck
npm run build
npm run build:opennext
```

The OpenNext configuration writes a local `.open-next/` artifact and includes
no deploy script, account identifier, route, DNS record, or server mutation.
