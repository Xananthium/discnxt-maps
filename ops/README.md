# Public map handoff

This directory records the small server seam between the versioned metric
assets and the OpenAI Sites viewer. It is not a deployment bundle.

## Invariants

- Reuse the project ID in `.openai/hosting.json`; never create a second Site.
- Push and verify the exact viewer commit before saving a Sites version.
- Build the OpenNext archive from that same commit and production epoch
  manifest.
- Publish only the files named by the accepted release allowlist. Never copy an
  ODM, Obj2Tiles, `.temp`, source-image, or model work directory recursively.
- Keep every epoch at an immutable path such as
  `/epochs/2026-07-29-v1/tiles/`.
- Leave inference disabled until both the external `DIS-2994` closure and
  `PHOTOGRAMMETRY_COMPLETE` verification exist.

## Production split

`maps.discnxt.com` terminates TLS on the lab server:

- `/epochs/*` is served from `/var/sites/maps.discnxt.com/public`;
- every other request is proxied to the existing public Sites deployment.

The reconstruction workspace and `/var` are on different filesystems. The
empty `staging` and `public` paths under `/var/sites/maps.discnxt.com` therefore
resolve to the dedicated `/home/maps-public` store on the reconstruction
filesystem. This preserves the promoter's hardlink-only contract without
changing the Caddy path. Verify both resolved paths and device IDs before each
promotion.

The checked-in Caddy snippet provides immutable cache headers, byte-range
compatible file serving, and cross-origin GET/HEAD support for Cesium and
Unreal clients. Validate the candidate and the complete Caddyfile before a
normal reload. Do not add a Sites bypass credential to Caddy.

## Promotion order

1. Complete geometry, container, codec, and official-validator gates against a
   non-public candidate.
2. Assemble the contentless-root tree with
   `tools/assemble_public_tiles_release.py`; require
   `status=assembled_unvalidated`.
3. Run `tools/promote_public_tiles_release.py`. It cross-correlates the exact
   five passed audits and creates a literal seven-file tree: four B3DMs,
   `tileset.json`, `release.json`, and `release-assets.json`. Validator reports,
   logs, screenshots, and sidecars remain private and cannot enter the public
   tree.
4. Atomically move that tree under the immutable epoch path and make it
   read-only while the Site remains owner-only and the Caddy vhost is absent.
5. Build and test the viewer with the exact production epoch JSON, push the
   exact source commit, save a Sites version, deploy that saved version
   owner-only, and verify the viewer shell at its direct Sites URL.
6. Make the Site public, install the validated Caddy vhost, and reload Caddy.
7. Crawl every public URI, verify range/CORS/cache behavior, load the fixed
   Cesium overview/detail bookmarks, make a finite metric pick, and save final
   screenshots. A failed live gate immediately removes the vhost from service
   and returns the Site to owner-only access.

Any failed prepublication gate leaves the viewer boundary-only and the
candidate assets unpublished. A failed live-render gate quarantines the
immutable epoch by removing its public route; it does not rewrite accepted
content in place.
