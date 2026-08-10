import { Redis } from 'ioredis';
import { config } from './config.js';
export const redis = new Redis(config.MCP_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
});
//# sourceMappingURL=redis.js.map