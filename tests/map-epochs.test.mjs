import assert from "node:assert/strict";
import test from "node:test";
import {
  BASELINE_EPOCH_ID,
  parsePublicMapEpochs
} from "../lib/mapEpochs.mjs";

const baseline = {
  id: BASELINE_EPOCH_ID,
  label: "Baseline",
  captureDate: BASELINE_EPOCH_ID,
  releaseId: "cemetery-2026-07-29-v1",
  modelStatusLabel: "Reviewed baseline.",
  metricTilesetUrl: "/epochs/2026-07-29/tileset.json",
  contentAttribution: "Discnxt",
  contentLicense: "CC BY 4.0",
  contentLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  publicReleaseApproved: true,
  privacyCropVerified: true
};

const future = {
  id: "2026-08-15",
  label: "Facade reshoot",
  captureDate: "2026-08-15",
  releaseId: "cemetery-2026-08-15-v1",
  modelStatusLabel: "Awaiting privacy review.",
  metricTilesetUrl: "https://assets.example/2026-08-15/tileset.json",
  contentAttribution: "Discnxt",
  contentLicense: "CC BY 4.0",
  contentLicenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  publicReleaseApproved: false,
  privacyCropVerified: true
};

function assertFailClosed(rawValue) {
  const epochs = parsePublicMapEpochs(rawValue);
  assert.equal(epochs.length, 1);
  assert.equal(epochs[0].id, BASELINE_EPOCH_ID);
  assert.equal(epochs[0].metricTilesetUrl, "");
  assert.equal(epochs[0].contentAttribution, "");
  assert.equal(epochs[0].contentLicense, "");
  assert.equal(epochs[0].contentLicenseUrl, "");
  assert.equal(epochs[0].publicReleaseApproved, false);
  assert.equal(epochs[0].privacyCropVerified, false);
}

test("valid epoch manifests are immutable, ordered, and retain per-epoch gates", () => {
  const epochs = parsePublicMapEpochs(JSON.stringify([future, baseline]));

  assert.deepEqual(
    epochs.map((epoch) => epoch.id),
    [BASELINE_EPOCH_ID, "2026-08-15"]
  );
  assert.equal(epochs[0].publicReleaseApproved, true);
  assert.equal(epochs[0].privacyCropVerified, true);
  assert.equal(epochs[0].contentLicense, "CC BY 4.0");
  assert.equal(epochs[1].publicReleaseApproved, false);
  assert.equal(epochs[1].privacyCropVerified, true);
  assert.equal(Object.isFrozen(epochs), true);
  assert.equal(epochs.every(Object.isFrozen), true);
});

test("missing or malformed epoch manifests fail closed as one atomic unit", () => {
  assertFailClosed(undefined);
  assertFailClosed("");
  assertFailClosed("{not-json");
  assertFailClosed("[]");
  assertFailClosed(JSON.stringify([future]));
  assertFailClosed(
    JSON.stringify([
      baseline,
      { ...future, publicReleaseApproved: "true" }
    ])
  );
  assertFailClosed(
    JSON.stringify([
      baseline,
      {
        ...future,
        id: BASELINE_EPOCH_ID,
        captureDate: BASELINE_EPOCH_ID
      }
    ])
  );
  assertFailClosed(
    JSON.stringify([
      baseline,
      { ...future, metricTilesetUrl: "http://public.example/tileset.json" }
    ])
  );
  assertFailClosed(
    JSON.stringify([
      baseline,
      { ...future, metricTilesetUrl: "/\\untrusted.example/tileset.json" }
    ])
  );
  assertFailClosed(
    JSON.stringify([{ ...baseline, undocumentedOverride: true }])
  );
  assertFailClosed(
    JSON.stringify([{ ...baseline, contentAttribution: "" }])
  );
  assertFailClosed(
    JSON.stringify([
      {
        ...baseline,
        contentLicenseUrl: "http://creativecommons.org/licenses/by/4.0/"
      }
    ])
  );
  assertFailClosed(
    JSON.stringify([{ ...baseline, contentLicenseUrl: "/model-license" }])
  );
});
