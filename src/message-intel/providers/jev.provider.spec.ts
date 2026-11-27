import { of, throwError } from 'rxjs';
import {
  buildJevQuestions,
  DEFAULT_THRESHOLDS,
  JEV_MODEL,
} from '../taxonomy/taxonomy-v1';
import { retryDelayMs, parseRetryAfter } from './backoff';
import { ClassifierError, type IntelVersion } from './classifier.interface';
import {
  type JevResponse,
  JevProvider,
  toClassifierError,
  toLabels,
} from './jev.provider';

const version: IntelVersion = {
  id: 1,
  model: JEV_MODEL,
  questions: buildJevQuestions(),
  thresholds: DEFAULT_THRESHOLDS,
};

/** Response đủ mọi câu hỏi; ghi đè từng câu qua `over`. */
function response(over: Record<string, unknown> = {}): JevResponse {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(version.questions)) {
    if (q.type === 'choice')
      answers[id] = {
        type: 'choice',
        choice: Object.keys(q.criteria)[0],
        confidence: 0.6,
        probabilities: {},
      };
    else if (q.type === 'score')
      answers[id] = {
        type: 'score',
        score: 0.2,
        confidence: 0.8,
        legend: {},
        probabilities: { 0: 0.8, 1: 0.1, 2: 0.05, 3: 0.05 },
      };
    else answers[id] = { type: 'noul', noul: 0.1 };
  }
  return {
    model: JEV_MODEL,
    answers: { ...answers, ...over } as JevResponse['answers'],
    usage: { input_tokens: 900, output_tokens: 30 },
  };
}

describe('toLabels', () => {
  it('choice lấy lựa chọn top 1; score lấy mức xác suất cao nhất, không làm tròn giá trị kỳ vọng', () => {
    const { labels, answers } = toLabels(
      response({
        intent: {
          type: 'choice',
          choice: 'complaint',
          confidence: 0.7,
          probabilities: { complaint: 0.7 },
        },
        sentiment: {
          type: 'choice',
          choice: 'negative',
          confidence: 0.9,
          probabilities: {},
        },
        // giá trị kỳ vọng 1.48 nhưng mức 2 có xác suất cao nhất
        urgency: {
          type: 'score',
          score: 1.48,
          confidence: 0.4,
          probabilities: { 0: 0.3, 1: 0.05, 2: 0.4, 3: 0.25 },
        },
      }),
      version,
    );
    expect(labels).toMatchObject({
      intent: 'complaint',
      sentiment: 'negative',
      urgency: 2,
      purchaseIntent: 0,
    });
    expect(answers.urgency).toMatchObject({ score: 1.48, level: 2 });
  });

  it('noul theo ngưỡng: ≥0,7 true, ≤0,3 false, ở giữa null; topic ≥ ngưỡng topic', () => {
    const { labels, answers } = toLabels(
      response({
        requires_reply: { type: 'noul', noul: 0.92 },
        requires_escalation: { type: 'noul', noul: 0.5 },
        is_anomaly: { type: 'noul', noul: 0.2 },
        topic_missing_items: { type: 'noul', noul: 0.81 },
        topic_delivery: { type: 'noul', noul: 0.5 },
        topic_pricing: { type: 'noul', noul: 0.49 },
      }),
      version,
    );
    expect(labels.requiresReply).toBe(true);
    expect(labels.requiresEscalation).toBeNull();
    expect(labels.isAnomaly).toBe(false);
    expect(labels.topics.sort()).toEqual(['delivery', 'missing_items']);
    expect(answers.topic_pricing).toBe(0.49);
  });

  it('response sai dạng → lỗi fatal, không lưu nhãn sai', () => {
    const bad = [
      response({ intent: undefined }),
      response({ intent: { type: 'noul', noul: 0.5 } }),
      response({ intent: { type: 'choice', choice: 'bogus' } }),
      response({
        urgency: { type: 'score', score: 1, probabilities: { 0: 0.5, 1: 0.5 } },
      }),
      response({ is_anomaly: { type: 'noul', noul: 1.2 } }),
    ];
    for (const r of bad)
      expect(() => toLabels(r, version)).toThrow(
        expect.objectContaining({ kind: 'fatal' }),
      );
  });
});

describe('toClassifierError', () => {
  const http = (
    status: number,
    data: unknown = {},
    headers: Record<string, string> = {},
  ) => ({
    response: { status, data, headers },
  });

  it('401/403 → auth (tạm dừng worker); 400/422 → fatal, không lộ phần input của request', () => {
    expect(toClassifierError(http(401)).kind).toBe('auth');
    const e = toClassifierError(
      http(422, {
        detail: [
          {
            loc: ['body', 'questions', 'urgency'],
            msg: 'Field required',
            input: 'nội dung tin của khách',
          },
        ],
      }),
    );
    expect(e.kind).toBe('fatal');
    expect(e.message).toContain('body.questions.urgency: Field required');
    expect(e.message).not.toContain('nội dung tin');
  });

  it('429 / 529 / 5xx / timeout / mạng → retry, đọc Retry-After', () => {
    const e = toClassifierError(http(429, {}, { 'retry-after': '7' }));
    expect(e).toMatchObject({ kind: 'retry', status: 429, retryAfterMs: 7000 });
    expect(toClassifierError(http(529)).kind).toBe('retry');
    expect(toClassifierError(http(503)).kind).toBe('retry');
    expect(toClassifierError({ code: 'ECONNABORTED' }).kind).toBe('retry');
    expect(toClassifierError({ code: 'ENOTFOUND' }).kind).toBe('retry');
  });
});

describe('backoff', () => {
  it('30s × 2^(n-1), tối đa 6 giờ, jitter nửa khoảng; Retry-After là mức tối thiểu', () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(15_000);
    expect(retryDelayMs(1, null, () => 0.999)).toBeLessThan(30_000);
    expect(retryDelayMs(3, null, () => 0)).toBe(60_000);
    expect(retryDelayMs(30, null, () => 0)).toBe(3 * 3_600_000);
    expect(retryDelayMs(1, 120_000, () => 0)).toBe(120_000);
    // Retry-After bất thường (quá 1 giờ) bị bỏ qua
    expect(retryDelayMs(1, 5 * 3_600_000, () => 0)).toBe(15_000);
  });

  it('đọc Retry-After dạng giây, ngày giờ HTTP và retry-after-ms', () => {
    const now = Date.parse('2026-11-27T03:00:00Z');
    expect(parseRetryAfter({ 'retry-after': '3' }, now)).toBe(3000);
    expect(
      parseRetryAfter({ 'retry-after': 'Fri, 27 Nov 2026 03:00:10 GMT' }, now),
    ).toBe(10_000);
    expect(parseRetryAfter({ 'retry-after-ms': '250' }, now)).toBe(250);
    expect(parseRetryAfter({}, now)).toBeNull();
  });
});

describe('JevProvider.classify', () => {
  const state = {
    business: 'b',
    conversation_type: 'private' as const,
    target: { role: 'customer' as const, text: 'hàng thiếu 2 gói' },
    quoted: null,
    previous: [],
  };
  const make = (
    key: string | undefined,
    post: jest.Mock,
    env: Record<string, string> = {},
  ) =>
    new JevProvider(
      { post } as any,
      {
        get: (k: string) => (k === 'AI_TYPESAFE_JEV_API_KEY' ? key : env[k]),
      } as any,
    );
  const httpError = (status: number) =>
    throwError(() => ({ response: { status, data: {}, headers: {} } }));
  type Call = [string, { model: string }, { headers: Record<string, string> }];

  it('gửi 1 request /v1/systemone với model ghim, state và toàn bộ câu hỏi; trả nhãn + token', async () => {
    const post = jest.fn().mockReturnValue(of({ data: response() }));
    const result = await make('k-test', post).classify(state, version);
    const [url, body, opts] = post.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string>; timeout: number },
    ];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(body).toEqual({
      model: JEV_MODEL,
      state,
      questions: version.questions,
    });
    expect(opts.headers.Authorization).toBe('Bearer k-test');
    expect(opts.timeout).toBe(10_000);
    expect(result).toMatchObject({ model: JEV_MODEL, inputTokens: 900 });
  });

  it('thiếu API key → lỗi auth, không gọi mạng', async () => {
    const post = jest.fn();
    await expect(
      make(' ', post).classify(state, version),
    ).rejects.toBeInstanceOf(ClassifierError);
    expect(post).not.toHaveBeenCalled();
  });

  it('lỗi HTTP được chuyển thành ClassifierError', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => ({
        response: { status: 429, data: {}, headers: {} },
      })),
    );
    await expect(
      make('k', post).classify(state, version),
    ).rejects.toMatchObject({ kind: 'retry', status: 429 });
  });

  it('TypeSafe lỗi tạm thời (429) → dự phòng OpenCode Go: jev-1.14, key AI_OPENCODEGO_API_KEY, user agent riêng', async () => {
    const post = jest
      .fn()
      .mockReturnValueOnce(httpError(429))
      .mockReturnValueOnce(of({ data: { ...response(), model: 'jev-1.14' } }));
    const result = await make('k-ts', post, {
      AI_OPENCODEGO_API_KEY: 'k-go',
    }).classify(state, version);
    const [url, body, opts] = post.mock.calls[1] as Call;
    expect(url).toBe('https://opencode.ai/inference/go/systemone/v1/systemone');
    expect(body.model).toBe('jev-1.14');
    expect(opts.headers.Authorization).toBe('Bearer k-go');
    expect(opts.headers['User-Agent']).toMatch(/^hisweetie-pos/);
    expect(result.model).toBe('jev-1.14');
  });

  it('chưa có key TypeSafe / hết tín dụng (402) → dự phòng; không bao giờ gửi key 9Router (AI_API_KEY) sang OpenCode', async () => {
    const post = jest.fn().mockReturnValue(of({ data: response() }));
    await make(undefined, post, {
      AI_API_KEY: 'k-9router',
      AI_OPENCODEGO_API_KEY: 'k-fb',
    }).classify(state, version);
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0] as Call)[2].headers.Authorization).toBe(
      'Bearer k-fb',
    );
    const post402 = jest
      .fn()
      .mockReturnValueOnce(httpError(402))
      .mockReturnValueOnce(of({ data: response() }));
    await make('k-ts', post402, { AI_OPENCODEGO_API_KEY: 'k-go' }).classify(
      state,
      version,
    );
    expect(post402).toHaveBeenCalledTimes(2);
  });

  it('chỉ có key 9Router (AI_API_KEY), chưa có AI_OPENCODEGO_API_KEY → không dự phòng, báo lỗi TypeSafe', async () => {
    const post = jest.fn().mockReturnValue(httpError(429));
    await expect(
      make('k-ts', post, { AI_API_KEY: 'k-9router' }).classify(state, version),
    ).rejects.toMatchObject({ kind: 'retry', status: 429 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('lỗi do request (422) → không thử dự phòng; dự phòng cũng lỗi → báo lỗi của dự phòng', async () => {
    const post = jest.fn().mockReturnValue(httpError(422));
    await expect(
      make('k-ts', post, { AI_OPENCODEGO_API_KEY: 'k-go' }).classify(
        state,
        version,
      ),
    ).rejects.toMatchObject({ kind: 'fatal' });
    expect(post).toHaveBeenCalledTimes(1);
    const both = jest
      .fn()
      .mockReturnValueOnce(httpError(503))
      .mockReturnValueOnce(httpError(401));
    await expect(
      make('k-ts', both, { AI_OPENCODEGO_API_KEY: 'k-go' }).classify(
        state,
        version,
      ),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });
});
