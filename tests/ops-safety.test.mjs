import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const viewerRoot = process.cwd();

test("Caddy handoff exposes only immutable epochs and the public Sites shell", async () => {
  const caddy = await readFile(
    join(viewerRoot, "ops", "Caddyfile.maps.discnxt.com"),
    "utf8",
  );

  assert.match(caddy, /^maps\.discnxt\.com \{/m);
  assert.match(caddy, /path \/epochs\/\*/);
  assert.match(caddy, /root \* \/var\/sites\/maps\.discnxt\.com\/public/);
  assert.match(caddy, /max-age=31536000, immutable/);
  assert.match(caddy, /Access-Control-Allow-Origin "\*"/);
  assert.match(
    caddy,
    /reverse_proxy https:\/\/saint-martins-3d-map\.xananthium\.chatgpt\.site/,
  );
  assert.doesNotMatch(caddy, /authorization|bearer|basic_auth|basicauth/i);
  assert.doesNotMatch(caddy, /file_server\s+browse/i);
});
