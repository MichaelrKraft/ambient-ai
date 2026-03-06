/**
 * Screenpipe REST API response types.
 * Screenpipe runs at localhost:3030 and exposes OCR text extracted from screenshots.
 */

// ── Raw API shapes ────────────────────────────────────────────────────────────

export interface ScreenpipeOCRContent {
  frame_id: number;
  text: string;         // Extracted OCR text — this is what we analyze
  timestamp: string;    // ISO 8601
  file_path: string;
  offset_index: number;
  app_name: string;     // e.g., "Code", "Terminal", "Chrome"
  window_name: string;  // Window title
  tags: string[];
  focused: boolean;
}

export interface ScreenpipeAudioContent {
  chunk_id: number;
  transcription: string;
  timestamp: string;
  file_path: string;
  offset_index: number;
  tags: string[];
  device_name: string;
  is_input_device: boolean;
}

export interface ScreenpipeResult {
  type: 'OCR' | 'Audio';
  content: ScreenpipeOCRContent | ScreenpipeAudioContent;
}

export interface ScreenpipePagination {
  limit: number;
  offset: number;
  total: number;
}

export interface ScreenpipeSearchResponse {
  data: ScreenpipeResult[];
  pagination: ScreenpipePagination;
}

// ── Raw SQL endpoint ──────────────────────────────────────────────────────────

export interface RawSqlRequest {
  query: string;
  params: (string | number)[];
}

export interface RawSqlResponse {
  rows: Record<string, unknown>[];
}

// ── Health endpoint ───────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  version?: string;
}

// ── Deduplicated internal representation ─────────────────────────────────────

export interface OcrEntry {
  text: string;
  appName: string;
  windowName: string;
  timestamp: string;
}

export interface ScreenpipeHealthStatus {
  running: boolean;
  version?: string;
}
