import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { AxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { JevState } from '../context/context-builder';
import { TOPIC_PREFIX } from '../taxonomy/taxonomy-v1';
import { parseRetryAfter } from './backoff';
import {
  ClassifierError,
  type ClassifierResult,
  type IntelLabels,
  type IntelVersion,
  type MessageClassifier,
} from './classifier.interface';

const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
const TIMEOUT_MS = 10_000;

type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type ScoreAnswer = {
  type: 'score';
  score: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};
type NoulAnswer = { type: 'noul'; noul: number };
type JevAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type JevResponse = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

const isProb = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const malformed = (why: string) =>
  new ClassifierError(`Jev trả kết quả sai dạng: ${why}`, 'fatal');

/** Mức có xác suất cao nhất của câu score (không làm tròn giá trị kỳ vọng `score`). */
function scoreLevel(id: string, answer: ScoreAnswer, levels: number) {
  const probs = answer.probabilities ?? {};
  let best = -1;
  let bestP = -1;
  for (let level = 0; level < levels; level++) {
    const p = probs[String(level)];
    if (!isProb(p)) throw malformed(`${id} thiếu xác suất mức ${level}`);
    if (p > bestP) [best, bestP] = [level, p];
  }
  return best;
}

/**
 * Chuẩn hoá response Jev về nhãn nội bộ theo bộ câu hỏi của phiên bản. Mọi câu hỏi phải có câu trả lời
 * đúng loại, lựa chọn phải nằm trong criteria — sai thì lỗi `fatal` (không lưu nhãn sai).
 * noul: ≥ yes → true, ≤ no → false, ở giữa → null (chưa chắc); topic: ≥ ngưỡng topic.
 */
export function toLabels(response: JevResponse, version: IntelVersion) {
  if (!response || typeof response !== 'object' || !response.answers)
    throw malformed('thiếu answers');
  const { yes, no, topic } = version.thresholds;
  const labels: IntelLabels = {
    intent: null,
    topics: [],
    sentiment: null,
    urgency: null,
    purchaseIntent: null,
    requiresReply: null,
    requiresEscalation: null,
    isAnomaly: null,
  };
  const answers: Record<string, unknown> = {};
  const flag = (p: number) => (p >= yes ? true : p <= no ? false : null);
  for (const [id, question] of Object.entries(version.questions)) {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type)
      throw malformed(`${id} thiếu hoặc sai loại`);
    if (answer.type === 'choice' && question.type === 'choice') {
      if (!(answer.choice in question.criteria))
        throw malformed(`${id} = "${answer.choice}" ngoài lựa chọn`);
      answers[id] = {
        choice: answer.choice,
        confidence: answer.confidence ?? null,
        probabilities: answer.probabilities ?? null,
      };
      if (id === 'intent') labels.intent = answer.choice;
      if (id === 'sentiment') labels.sentiment = answer.choice;
    } else if (answer.type === 'score' && question.type === 'score') {
      const level = scoreLevel(id, answer, question.criteria.length);
      answers[id] = {
        score: answer.score,
        level,
        confidence: answer.confidence ?? null,
        probabilities: answer.probabilities,
      };
      if (id === 'urgency') labels.urgency = level;
      if (id === 'purchase_intent') labels.purchaseIntent = level;
    } else if (answer.type === 'noul') {
      if (!isProb(answer.noul)) throw malformed(`${id} không phải xác suất`);
      answers[id] = answer.noul;
      if (id.startsWith(TOPIC_PREFIX)) {
        if (answer.noul >= topic)
          labels.topics.push(id.slice(TOPIC_PREFIX.length));
      } else if (id === 'requires_reply')
        labels.requiresReply = flag(answer.noul);
      else if (id === 'requires_escalation')
        labels.requiresEscalation = flag(answer.noul);
      else if (id === 'is_anomaly') labels.isAnomaly = flag(answer.noul);
    }
  }
  return { labels, answers };
}

/** Lỗi HTTP → loại xử lý. Không đưa nội dung request / phần `input` của lỗi 422 vào thông báo. */
export function toClassifierError(error: unknown): ClassifierError {
  if (error instanceof ClassifierError) return error;
  const axios = error as AxiosError<{ detail?: unknown }>;
  const status = axios?.response?.status ?? null;
  if (status === null) {
    const timeout =
      axios?.code === 'ECONNABORTED' || axios?.code === 'ETIMEDOUT';
    return new ClassifierError(
      timeout
        ? 'Jev quá thời gian chờ'
        : `Không gọi được Jev (${axios?.code ?? 'lỗi mạng'})`,
      'retry',
    );
  }
  const detail = axios.response?.data?.detail;
  const why = Array.isArray(detail)
    ? detail
        .map(
          (d: { loc?: unknown[]; msg?: string }) =>
            `${(d.loc ?? []).join('.')}: ${d.msg ?? ''}`,
        )
        .join('; ')
    : typeof detail === 'string'
      ? detail
      : '';
  const message = `Jev HTTP ${status}${why ? `: ${why.slice(0, 300)}` : ''}`;
  if (status === 401 || status === 403)
    return new ClassifierError(message, 'auth', status);
  if (status === 408 || status === 429 || status >= 500)
    return new ClassifierError(
      message,
      'retry',
      status,
      parseRetryAfter(
        axios.response?.headers as Record<string, unknown> | undefined,
      ),
    );
  return new ClassifierError(message, 'fatal', status);
}

/** Dự phòng: Jev qua OpenCode Go (cùng System One API, model id không có bản vá). */
const FALLBACK_BASE_URL = 'https://opencode.ai/inference/go/systemone/v1';
const FALLBACK_MODEL = 'jev-1.14';
/** OpenCode yêu cầu client tự giới thiệu bằng user agent riêng. */
const USER_AGENT = 'hisweetie-pos-message-intel/1.0';

/**
 * Lỗi đáng thử nhà cung cấp dự phòng: tạm thời (429 / 529 / 5xx / timeout / mạng), sai / thiếu key, hết tín dụng
 * (402). Lỗi do request (400 / 422) gửi lại chỗ khác cũng lỗi → không thử.
 */
const shouldFallback = (e: ClassifierError) =>
  e.kind === 'retry' || e.kind === 'auth' || e.status === 402;

/**
 * Gọi Jev `POST …/systemone` (1 request / tin, mọi câu hỏi trong cùng request): TypeSafe trước
 * (AI_TYPESAFE_JEV_API_KEY, model ghim của phiên bản), lỗi tạm thời / key / tín dụng thì chuyển OpenCode Go
 * (AI_OPENCODEGO_API_KEY; model AI_JEV_FALLBACK_MODEL, mặc định jev-1.14). AI_API_KEY là key 9Router của
 * DeepSeek, không dùng cho Jev.
 */
@Injectable()
export class JevProvider implements MessageClassifier {
  private readonly logger = new Logger(JevProvider.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private env(key: string) {
    return this.config.get<string>(key)?.trim() || undefined;
  }

  private get primaryKey() {
    return this.env('AI_TYPESAFE_JEV_API_KEY');
  }

  private get fallbackKey() {
    return this.env('AI_OPENCODEGO_API_KEY');
  }

  get configured() {
    return !!this.primaryKey || !!this.fallbackKey;
  }

  get fallbackConfigured() {
    return !!this.fallbackKey;
  }

  async classify(
    state: JevState,
    version: IntelVersion,
  ): Promise<ClassifierResult> {
    const started = Date.now();
    let response: JevResponse;
    try {
      const key = this.primaryKey;
      if (!key)
        throw new ClassifierError(
          'Chưa cấu hình AI_TYPESAFE_JEV_API_KEY',
          'auth',
        );
      const base = (
        this.env('AI_TYPESAFE_JEV_BASE_URL') || DEFAULT_BASE_URL
      ).replace(/\/+$/, '');
      response = await this.post(
        `${base}/v1/systemone`,
        key,
        version.model,
        state,
        version,
      );
    } catch (error) {
      const primary = toClassifierError(error);
      const key = this.fallbackKey;
      if (!key || !shouldFallback(primary)) throw primary;
      this.logger.warn(
        `Jev TypeSafe lỗi (${primary.message}) → dùng dự phòng OpenCode Go`,
      );
      const base = (
        this.env('AI_JEV_FALLBACK_BASE_URL') || FALLBACK_BASE_URL
      ).replace(/\/+$/, '');
      try {
        response = await this.post(
          `${base}/systemone`,
          key,
          this.env('AI_JEV_FALLBACK_MODEL') || FALLBACK_MODEL,
          state,
          version,
        );
      } catch (fallbackError) {
        throw toClassifierError(fallbackError);
      }
    }
    const { labels, answers } = toLabels(response, version);
    const inputTokens = Number(response.usage?.input_tokens);
    return {
      labels,
      answers,
      model:
        typeof response.model === 'string' ? response.model : version.model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      latencyMs: Date.now() - started,
    };
  }

  private async post(
    url: string,
    key: string,
    model: string,
    state: JevState,
    version: IntelVersion,
  ) {
    const res = await firstValueFrom(
      this.http.post<JevResponse>(
        url,
        { model, state, questions: version.questions },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          timeout: TIMEOUT_MS,
        },
      ),
    );
    return res.data;
  }
}
