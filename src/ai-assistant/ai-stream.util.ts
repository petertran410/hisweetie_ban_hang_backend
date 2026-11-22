import * as compression from 'compression';

export const AI_AGENT_PATH = '/api/ai/agent';

type FilterArgs = Parameters<typeof compression.filter>;

/** Bộ lọc `compression()`: không nén stream trợ lý AI (SSE) — nén sẽ dồn sự kiện lại. */
export function compressUnlessAiStream(
  req: FilterArgs[0],
  res: FilterArgs[1],
): boolean {
  return (
    !req.originalUrl?.startsWith(AI_AGENT_PATH) && compression.filter(req, res)
  );
}
