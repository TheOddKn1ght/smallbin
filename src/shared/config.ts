export const LIMITS = Object.freeze({
  maxFileBytes: 100_000_000,
  maxTextBytes: 1_000_000,
  maxMetadataBytes: 16_384,
  maxEnvelopeBytes: 101_016_421,
});

export const EXPIRY_OPTIONS = [
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 7_200, label: "2 hours" },
  { seconds: 14_400, label: "4 hours" },
  { seconds: 43_200, label: "12 hours" },
] as const;

export const DEFAULT_TTL_SECONDS = 300;
export const MIN_ENVELOPE_BYTES = 37;

export interface ApiConfig {
  maxFileBytes: number;
  maxTextBytes: number;
  expiryOptions: ReadonlyArray<{ seconds: number; label: string }>;
  defaultTtlSeconds: number;
}

export const PUBLIC_CONFIG: ApiConfig = {
  maxFileBytes: LIMITS.maxFileBytes,
  maxTextBytes: LIMITS.maxTextBytes,
  expiryOptions: EXPIRY_OPTIONS,
  defaultTtlSeconds: DEFAULT_TTL_SECONDS,
};
