import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const viewerRoot = process.cwd();

test("Caddy handoff exposes immutable epochs and the loopback viewer", async () => {
  const caddy = await readFile(
    join(viewerRoot, "ops", "Caddyfile.maps.discnxt.com"),
    "utf8",
  );

  assert.match(caddy, /^maps\.discnxt\.com \{/m);
  assert.match(
    caddy,
    /@epochPreflight \{[\s\S]*method OPTIONS[\s\S]*path \/epochs\/\*[\s\S]*\}[\s\S]*handle @epochPreflight \{[\s\S]*Access-Control-Allow-Headers "Range"[\s\S]*Access-Control-Allow-Methods "GET, HEAD, OPTIONS"[\s\S]*respond "" 204[\s\S]*\}/,
  );
  assert.match(
    caddy,
    /@epochAssets path \/epochs\/\*[\s\S]*handle @epochAssets \{[\s\S]*root \* \/var\/sites\/maps\.discnxt\.com\/public[\s\S]*max-age=31536000, immutable[\s\S]*file_server[\s\S]*\}/,
  );
  assert.match(caddy, /max-age=31536000, immutable/);
  assert.match(caddy, /Access-Control-Allow-Origin "\*"/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:4310/);
  assert.equal(caddy.match(/\breverse_proxy\b/g)?.length, 1);
  assert.equal(caddy.match(/\bfile_server\b/g)?.length, 1);
  assert.doesNotMatch(caddy, /xananthium\.chatgpt\.site/);
  assert.doesNotMatch(caddy, /reverse_proxy\s+(?:https?:\/\/|[^\s]*:[^4]\d*)/);
  assert.doesNotMatch(caddy, /authorization|bearer|basic_auth|basicauth/i);
  assert.doesNotMatch(caddy, /file_server\s+browse/i);
});

test("systemd template isolates a read-only exact-commit runtime", async () => {
  const unit = await readFile(
    join(viewerRoot, "ops", "discnxt-maps-viewer.service.in"),
    "utf8",
  );

  assert.match(unit, /^User=discnxt-maps$/m);
  assert.match(unit, /^Group=discnxt-maps$/m);
  assert.match(
    unit,
    /^WorkingDirectory=\/srv\/discnxt-maps\/releases\/@COMMIT@$/m,
  );
  assert.match(
    unit,
    /^EnvironmentFile=\/etc\/discnxt-maps\/releases\/@COMMIT@\.env$/m,
  );
  for (const setting of [
    "NoNewPrivileges=true",
    "PrivateDevices=true",
    "PrivateTmp=true",
    "ProtectHome=true",
    "ProtectSystem=strict",
    "RestrictSUIDSGID=true",
    "LockPersonality=true",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
  ]) {
    assert.match(unit, new RegExp(`^${setting.replace("=", "\\=")}$`, "m"));
  }
  assert.doesNotMatch(unit, /User=cass|\/home\/cass/);
});
