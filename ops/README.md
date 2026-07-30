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

The checked-in Caddy snippet provides immutable cache headers, byte-range
compatible file serving, and cross-origin GET/HEAD support for Cesium and
Unreal clients. Validate the candidate and the complete Caddyfile before a
normal reload. Do not add a Sites bypass credential to Caddy.

## Promotion order

1. Complete geometry, container, codec, official-validator, and fixed-camera
   render gates against a non-public candidate.
2. Assemble the contentless-root tree with
   `tools/assemble_public_tiles_release.py`; require
   `status=assembled_unvalidated`.
3. Add the dated public release record, model-license notice, validator
   reports, asset manifest, and screenshot sidecars to a separate literal
   allowlist.
4. Install that allowlist under the immutable epoch path and make it
   read-only.
5. Build and test the viewer with the exact production epoch JSON, push the
   exact source commit, save a Sites version, and deploy that saved version.
6. Make the Site public, install the validated Caddy vhost, and reload Caddy.
7. Crawl every public URI, verify range/CORS/cache behavior, load the fixed
   Cesium overview/detail bookmarks, make a finite metric pick, and save final
   screenshots.

Any failed gate leaves the viewer boundary-only and the candidate assets
unpublished.
