# Public map operations

This directory records the small, native server seam between the versioned
metric assets and the public viewer. It is not a deployment bundle.

## Invariants

- Run the viewer directly with Node and systemd; do not add Docker.
- Build one exact, pushed commit outside the serving tree, prune development
  dependencies, then install it root-owned and non-writable under `/srv`.
- Keep the Next.js listener on `127.0.0.1:4310`; Caddy owns the public socket
  and TLS.
- Put only browser-readable `NEXT_PUBLIC_*` values in the viewer environment.
  The service needs no credential.
- Publish only files named by the accepted release allowlist. Never copy an
  ODM, Obj2Tiles, `.temp`, source-image, or model work directory recursively.
- Keep every epoch at an immutable path such as
  `/epochs/2026-07-29-v1/tiles/`.
- Leave inference disabled until both the external `DIS-2994` closure and
  `PHOTOGRAMMETRY_COMPLETE` verification exist.

## Production layout

`maps.discnxt.com` terminates TLS on the lab server:

- `/epochs/*` is served from `/var/sites/maps.discnxt.com/public`;
- every other request is proxied to the loopback Next.js service;
- the service runs as the dedicated `discnxt-maps` identity from
  `/srv/discnxt-maps/releases/<commit>`;
- its version-paired public environment is
  `/etc/discnxt-maps/releases/<commit>.env`.

The reconstruction workspace and `/var` are on different filesystems. The
`staging` and `public` paths under `/var/sites/maps.discnxt.com` resolve to the
dedicated `/home/maps-public` store on the reconstruction filesystem. This
preserves the promoter's hardlink-only contract without changing the Caddy
path. Verify both resolved paths and device IDs before each promotion.

The checked-in Caddy snippet provides immutable cache headers, byte-range
compatible file serving, cross-origin GET/HEAD/OPTIONS support for Cesium and
Unreal clients, and no directory browsing. Validate the candidate and the
complete Caddyfile as the `caddy` user before a normal reload.

An OpenAI Sites version also exists, but the attempted public access update was
rejected with `sites_publish_disabled`. It remains owner-only, is not in the
production request path, and its saved source predates the current native
commit. Reuse its project ID from `.openai/hosting.json` if policy changes;
never create a second Site.

## Viewer deployment

1. Push the exact source commit and verify that the remote branch contains it.
2. Clone that exact commit into a new non-serving build directory.
3. Export the public production environment, then run `npm ci`, `npm test`,
   `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and
   `npm prune --omit=dev` in that directory.
4. Install the pruned tree at `/srv/discnxt-maps/releases/<commit>` and its
   exact build environment at `/etc/discnxt-maps/releases/<commit>.env`.
   Require root ownership, group read/execute for `discnxt-maps`, and no write
   bit on any deployed path.
5. Render `ops/discnxt-maps-viewer.service.in` with the exact full commit,
   install it, run `systemctl daemon-reload`, and restart the service.
6. Require an active unit, zero automatic restarts, the recorded
   commit/build/environment tuple, read-only filesystem isolation, and an HTTP
   200 response from `127.0.0.1:4310`.
7. Validate the complete Caddy configuration as the `caddy` user, reload
   Caddy, and require the exact seven-file epoch inventory. Rehash all six
   assets listed in `release-assets.json`, independently rehash that manifest,
   and check the shell, boundary, tileset, both release JSON files, all four
   B3DM assets, byte ranges, CORS, and immutable cache headers. `root.b3dm`,
   audit reports, source files, and an unknown URI must return 404.
8. Run browser QA against the public domain. Require the fixed epoch and
   release ID, visible attribution, finite WGS84/ECEF values, a two-point
   approved-tile measurement at plausible mesh heights, no failed requests,
   no HTTP errors, no console errors, and saved overview, oblique, and metric
   screenshots.

Rollback restores the previously recorded commit/build/environment tuple in
the unit, runs `systemctl daemon-reload`, restarts the service, and repeats both
loopback and public health gates. It never rewrites an accepted epoch.

## Epoch promotion

1. Complete geometry, container, codec, and official-validator gates against a
   non-public candidate.
2. Assemble the contentless-root tree with
   `tools/assemble_public_tiles_release.py`; require
   `status=assembled_unvalidated`.
3. Run `tools/promote_public_tiles_release.py`. It cross-correlates the exact
   five passed audits and creates a literal seven-file tree: four B3DMs,
   `tileset.json`, `release.json`, and `release-assets.json`. Validator reports,
   logs, screenshots, and sidecars remain private.
4. Atomically move the accepted tree under the immutable epoch path, make it
   read-only, and run the complete public edge and browser gates above.

Any failed prepublication gate leaves the candidate unpublished. To quarantine
a live epoch without modifying it, add a matcher before `@epochAssets` for its
exact `/epochs/<release-id>/*` path and `respond "" 404`; validate the complete
Caddyfile as `caddy`, reload, and require both the quarantined URI and an
unknown URI to return 404. Restoration removes only that exact matcher, repeats
validation/reload, and reruns every public gate. A viewer-only failure uses the
tuple rollback above.
