import { z } from 'zod';

const clientSchema = z.object({
  clientId: z.string().min(3),
  clientSecret: z.string().min(12),
  name: z.string().min(1),
  scopes: z.array(z.string()).default(['pos:read']),
});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MCP_PORT: z.coerce.number().int().positive().default(3062),
  MCP_PUBLIC_URL: z.string().trim().url().default('http://localhost:3062'),
  POS_API_BASE_URL: z.string().trim().url(),
  POS_SERVICE_EMAIL: z
    .string()
    .trim()
    .email(
      'POS_SERVICE_EMAIL must be a real POS login email, for example user@company.com',
    ),
  POS_SERVICE_PASSWORD: z.string().min(1),
  MCP_JWT_SECRET: z.string().trim().min(32),
  MCP_REDIS_URL: z.string().trim().min(1),
  MCP_ALLOWED_ORIGINS: z.string().default(''),
  MCP_CLIENTS: z.string().transform((value, ctx) => {
    try {
      return z.array(clientSchema).min(1).parse(JSON.parse(value));
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MCP_CLIENTS must be a valid client JSON array',
      });
      return z.NEVER;
    }
  }),
});

export const config = envSchema.parse(process.env);
export const allowedOrigins = new Set(config.MCP_ALLOWED_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean));
export type McpClientConfig = z.infer<typeof clientSchema>;
