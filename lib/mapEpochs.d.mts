export interface PublicMapEpoch {
  readonly id: string;
  readonly label: string;
  readonly captureDate: string;
  readonly releaseId: string;
  readonly modelStatusLabel: string;
  readonly metricTilesetUrl: string;
  readonly contentAttribution: string;
  readonly contentLicense: string;
  readonly contentLicenseUrl: string;
  readonly publicReleaseApproved: boolean;
  readonly privacyCropVerified: boolean;
}

export declare const BASELINE_EPOCH_ID: "2026-07-29";

export declare function parsePublicMapEpochs(
  rawValue: string | null | undefined
): readonly PublicMapEpoch[];
