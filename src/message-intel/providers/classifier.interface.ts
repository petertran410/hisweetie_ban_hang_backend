import type { JevState } from '../context/context-builder';
import type { IntelThresholds, JevQuestion } from '../taxonomy/taxonomy-v1';

/** Phiên bản taxonomy đang dùng (đọc từ smax_intel_versions). */
export type IntelVersion = {
  id: number;
  model: string;
  questions: Record<string, JevQuestion>;
  thresholds: IntelThresholds;
};

/** Nhãn đã chuẩn hoá về schema nội bộ. null = chưa chắc (xác suất nằm giữa 2 ngưỡng) hoặc không hỏi. */
export type IntelLabels = {
  intent: string | null;
  topics: string[];
  sentiment: string | null;
  urgency: number | null;
  purchaseIntent: number | null;
  requiresReply: boolean | null;
  requiresEscalation: boolean | null;
  isAnomaly: boolean | null;
};

export type ClassifierResult = {
  labels: IntelLabels;
  /** Xác suất gốc theo câu hỏi (không chứa nội dung tin) */
  answers: Record<string, unknown>;
  /** Model thật nhà cung cấp trả về */
  model: string;
  inputTokens: number;
  latencyMs: number;
};

/**
 * retry: thử lại sau (429 / 529 / 5xx / timeout / mạng); fatal: không thử lại (câu hỏi / response sai);
 * auth: sai hoặc thiếu API key → worker tạm dừng.
 */
export type ClassifierErrorKind = 'retry' | 'fatal' | 'auth';

export class ClassifierError extends Error {
  constructor(
    message: string,
    readonly kind: ClassifierErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export interface MessageClassifier {
  classify(state: JevState, version: IntelVersion): Promise<ClassifierResult>;
}
