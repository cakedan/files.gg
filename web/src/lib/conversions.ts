/**
 * The conversion API (milestone-5 §10), typed, with lib/api's conventions: same-origin
 * `/api`, the CSRF header on writes, `Authorization: Guest` while signed out (anonymous callers
 * call `ensureGuest()` first), and `ApiError` on any non-2xx answer. Dashboard
 * only: the viewer links to the Convert page and never calls these.
 */

import { request, type AlbumRef, type FilePayload, type OwnerAlbumSummary, type OwnerFile, type ViewLimitAction, type Visibility } from './api';
import type { ConversionKind, SourceKind } from './convertKinds';

export type { ConversionKind, SourceKind } from './convertKinds';

// ---------------------------------------------------------------------------
// §10.1 `GET /conversions/formats`
// ---------------------------------------------------------------------------

/** §10.1: every option type has a control on the Convert page. */
export const OPTION_TYPES = ['int', 'number', 'bool', 'enum', 'color', 'pages', 'size'] as const;
export type OptionType = (typeof OPTION_TYPES)[number];

/** An enum value: `1080`, `"a4"`. `null` (in `default`) is "none". */
export type EnumValue = string | number;
export type OptionValue = string | number | boolean | null;

export interface FormatOption {
  name: string;
  type: OptionType;
  label: string;
  /** `null` is "none" (the source's own value, or no limit). */
  default: OptionValue;
  /** `enum`: the choices, without "none" (a `null` default adds it). */
  values?: EnumValue[];
  /** `int`, `number` and `size` (MB): the range, inclusive. */
  min?: number;
  max?: number;
  /** `size`: named sizes in MB, `{ "discord": 10 }`. */
  presets?: Record<string, number>;
  /** A short explanation under the control. */
  help?: string;
}

export interface FormatTarget {
  /** `mp4`, `png`, …: what `POST /conversions` takes as `target`. */
  target: string;
  label: string;
  /** For grouping chips: `image`, `video`, `audio`, `document`. */
  group: string;
  /** False when anonymous callers can't use it (§7.1 `document → pdf`). */
  anonymous: boolean;
  options: FormatOption[];
}

export interface FormatKind {
  targets: FormatTarget[];
}

export interface FormatPreset {
  id: string;
  label: string;
  kinds: SourceKind[];
  /** A target, or `same` (the source's own format). */
  target: string;
  options: Record<string, OptionValue>;
}

export interface FormatsDocument {
  version: number;
  /** Keyed by §1.1 kind, plus `images` (several images, or an album, to PDF). */
  kinds: Partial<Record<ConversionKind, FormatKind>>;
  presets: FormatPreset[];
}

// ---------------------------------------------------------------------------
// §10.2 The conversion object
// ---------------------------------------------------------------------------

export const CONVERSION_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type ConversionStatus = (typeof CONVERSION_STATUSES)[number];
export type ConversionStage = 'downloading' | 'converting' | 'storing';
export type ConversionQueue = 'premium' | 'member' | 'anonymous';

/** §12: the codes a conversion's `error` (or `POST`) can carry. */
export type ConversionErrorCode =
  | 'UNSUPPORTED_CONVERSION'
  | 'INVALID_OPTION'
  | 'TARGET_SIZE_TOO_SMALL'
  | 'CONVERSION_TOO_LARGE'
  | 'CONVERSION_LIMIT_REACHED'
  | 'CONVERSION_REQUIRES_ACCOUNT'
  | 'SOURCE_UNAVAILABLE'
  | 'VIEW_LIMITED_SOURCE'
  | 'CONVERTER_BUSY'
  | 'CONVERSION_TIMEOUT'
  | 'CONVERSION_FAILED'
  | 'FILE_BLOCKED'
  | 'STORAGE_LIMIT_REACHED'
  | (string & {});

export interface ConversionError {
  code: ConversionErrorCode;
  message: string;
  /** `reason`, `limit`, `value`, `unit`, `sign_in`, the timeout's seconds and `tier`, … */
  metadata?: Record<string, unknown> | null;
}

/** The output file: the owner payload, with the safety state the result card waits on. */
export type ConversionOutputFile = OwnerFile;

export interface Conversion {
  id: string;
  status: ConversionStatus;
  /** Jobs ahead while queued, else 0. */
  position: number;
  queue: ConversionQueue;
  /** While running. */
  stage: ConversionStage | null;
  /** 0–1. */
  progress: number;
  /** Seconds the work horse gets. */
  time_limit: number;
  /** Milliseconds from creation until it finished (or until now). */
  took: number | null;
  source: {
    kind: ConversionKind;
    file: FilePayload | null;
    album: OwnerAlbumSummary | AlbumRef | null;
    count: number;
  };
  target: string;
  options: Record<string, OptionValue>;
  cached: boolean;
  output: {
    file: ConversionOutputFile | null;
    album: OwnerAlbumSummary | null;
    /** A generated passphrase, only on the response that created it. */
    password?: string;
  };
  error: ConversionError | null;
  input_size: number | null;
  output_size: number | null;
  cpu_seconds: number | null;
  /** Epoch seconds. */
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export const isActive = (conversion: Pick<Conversion, 'status'>): boolean => conversion.status === 'queued' || conversion.status === 'running';

// ---------------------------------------------------------------------------
// §10.3 / §10.6 requests
// ---------------------------------------------------------------------------

/** The output fields shared by `POST /conversions` and `POST /conversions/batch` (§5.3, §5.5). */
export interface ConversionOutputParams {
  visibility?: Visibility;
  password?: string;
  generate_password?: boolean;
  /** Seconds; signed in, `null` keeps forever. */
  expires_in?: number | null;
  view_limit?: number;
  view_limit_action?: ViewLimitAction;
}

export type ConversionSource = { source: string } | { sources: string[] } | { album: string };

export type CreateConversionBody = ConversionSource &
  ConversionOutputParams & {
    target?: string;
    options?: Record<string, OptionValue>;
    /** Anonymous callers: action `convert`. */
    turnstile_token?: string;
  };

export type BatchSource = { files: string[] } | { album: string };

export type CreateBatchBody = BatchSource &
  ConversionOutputParams & {
    target: string;
    options?: Record<string, OptionValue>;
  };

export interface BatchSkipped {
  source: string;
  code: string;
}

export interface BatchResponse {
  batch_id: string;
  items: Conversion[];
  skipped: BatchSkipped[];
}

export interface ConversionPage {
  items: Conversion[];
  next: string | null;
}

export interface HistoryParams {
  before?: string | undefined;
  /** 1–100, default 50. */
  limit?: number | undefined;
}

const conversionUrl = (id: string) => `/conversions/${encodeURIComponent(id)}`;

/** A protected source's unlock (or album) token, `X-Filesgg-Access` (§5.1). */
const accessHeader = (token: string | null | undefined): Record<string, string> | undefined =>
  token ? { 'X-Filesgg-Access': token } : undefined;

export const conversionApi = {
  /** Public; cacheable for 5 minutes. */
  formats: (signal?: AbortSignal) => request<FormatsDocument>('/conversions/formats', { signal }),
  /** `200` finished (succeeded, failed or a cache hit), `202` still queued or running. */
  create: (body: CreateConversionBody, accessToken?: string | null) =>
    request<Conversion>('/conversions', { method: 'POST', body, headers: accessHeader(accessToken) }),
  /** Signed in only. */
  createBatch: (body: CreateBatchBody) => request<BatchResponse>('/conversions/batch', { method: 'POST', body }),
  get: (id: string, signal?: AbortSignal) => request<Conversion>(conversionUrl(id), { signal }),
  /** Queued or running: cancels (`200 <conversion>`). Finished: forgets it (`204`, the output file stays). */
  remove: (id: string) => request<Conversion | undefined>(conversionUrl(id), { method: 'DELETE' }),
  history: (params: HistoryParams = {}, signal?: AbortSignal) =>
    request<ConversionPage>('/users/@me/conversions', { query: { ...params }, signal }),
  batch: (batchId: string, signal?: AbortSignal) =>
    request<ConversionPage>('/conversions', { query: { batch: batchId }, signal }),
  /**
   * The public payload of a source named by `?source=` (milestone-3 §4, `GET /files/<vanity>`):
   * a password file comes back locked unless the token is sent.
   */
  sourceFile: (vanity: string, accessToken?: string | null, signal?: AbortSignal) =>
    request<FilePayload & { protected?: string; view_limited?: boolean }>(`/files/${vanity.split('/').map(encodeURIComponent).join('/')}`, {
      signal,
      headers: accessHeader(accessToken),
    }),
};
