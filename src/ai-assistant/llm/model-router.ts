import { LlmError, type LlmClient } from './openai-chat-client';

/**
 * One `LlmClient` over both providers: `claude-*` models go to the Anthropic API, every other
 * model to the OpenAI-compatible gateway. A model whose provider has no key fails as an
 * `LlmError`, so the assistant moves on to its next model.
 */
export function createModelRouter(clients: {
  claude: LlmClient | null;
  gateway: LlmClient | null;
}): LlmClient | null {
  if (!clients.claude && !clients.gateway) return null;
  return {
    complete(request) {
      const client = request.model.startsWith('claude-')
        ? clients.claude
        : clients.gateway;
      if (!client)
        return Promise.reject(
          new LlmError(`llm_not_configured: ${request.model}`, null),
        );
      return client.complete(request);
    },
  };
}
