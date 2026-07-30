export const BASELINE_EPOCH_ID = "2026-07-29";

const REQUIRED_KEYS = new Set([
  "id",
  "label",
  "captureDate",
  "releaseId",
  "modelStatusLabel",
  "metricTilesetUrl",
  "publicReleaseApproved",
  "privacyCropVerified"
]);

const FAIL_CLOSED_BASELINE = Object.freeze({
  id: BASELINE_EPOCH_ID,
  label: "Baseline",
  captureDate: BASELINE_EPOCH_ID,
  releaseId: "preview-no-public-release",
  modelStatusLabel:
    "Map epoch configuration is missing or invalid; boundary-only preview is active.",
  metricTilesetUrl: "",
  publicReleaseApproved: false,
  privacyCropVerified: false
});

const FAIL_CLOSED_EPOCHS = Object.freeze([FAIL_CLOSED_BASELINE]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().startsWith(value);
}

function isBoundedText(value, maximumLength) {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function isPublicAssetUrl(value) {
  if (value === "") {
    return true;
  }
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\\]/.test(value)
  ) {
    return false;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    return true;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isEpoch(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== REQUIRED_KEYS.size ||
    keys.some((key) => !REQUIRED_KEYS.has(key))
  ) {
    return false;
  }
  return (
    isIsoDate(value.id) &&
    value.captureDate === value.id &&
    value.id >= BASELINE_EPOCH_ID &&
    isBoundedText(value.label, 80) &&
    isBoundedText(value.releaseId, 128) &&
    /^[A-Za-z0-9._-]+$/.test(value.releaseId) &&
    isBoundedText(value.modelStatusLabel, 240) &&
    isPublicAssetUrl(value.metricTilesetUrl) &&
    typeof value.publicReleaseApproved === "boolean" &&
    typeof value.privacyCropVerified === "boolean"
  );
}

/**
 * Parse the browser-readable epoch manifest as one atomic, append-only list.
 * Any malformed entry closes every metric gate and returns the built-in
 * boundary-only baseline rather than partially accepting a release.
 */
export function parsePublicMapEpochs(rawValue) {
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    return FAIL_CLOSED_EPOCHS;
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return FAIL_CLOSED_EPOCHS;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every(isEpoch)
  ) {
    return FAIL_CLOSED_EPOCHS;
  }

  const ids = new Set();
  const releaseIds = new Set();
  for (const epoch of parsed) {
    if (ids.has(epoch.id) || releaseIds.has(epoch.releaseId)) {
      return FAIL_CLOSED_EPOCHS;
    }
    ids.add(epoch.id);
    releaseIds.add(epoch.releaseId);
  }
  if (!ids.has(BASELINE_EPOCH_ID)) {
    return FAIL_CLOSED_EPOCHS;
  }

  const epochs = parsed
    .map((epoch) =>
      Object.freeze({
        id: epoch.id,
        label: epoch.label,
        captureDate: epoch.captureDate,
        releaseId: epoch.releaseId,
        modelStatusLabel: epoch.modelStatusLabel,
        metricTilesetUrl: epoch.metricTilesetUrl,
        publicReleaseApproved: epoch.publicReleaseApproved,
        privacyCropVerified: epoch.privacyCropVerified
      })
    )
    .sort((left, right) => left.captureDate.localeCompare(right.captureDate));

  return Object.freeze(epochs);
}
