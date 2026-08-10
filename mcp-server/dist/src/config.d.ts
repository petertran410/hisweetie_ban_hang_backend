import { z } from 'zod';
declare const clientSchema: z.ZodObject<{
    clientId: z.ZodString;
    clientSecret: z.ZodString;
    name: z.ZodString;
    scopes: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    clientId: string;
    clientSecret: string;
    name: string;
    scopes: string[];
}, {
    clientId: string;
    clientSecret: string;
    name: string;
    scopes?: string[] | undefined;
}>;
export declare const config: {
    NODE_ENV: "development" | "test" | "production";
    MCP_PORT: number;
    MCP_PUBLIC_URL: string;
    POS_API_BASE_URL: string;
    POS_SERVICE_EMAIL: string;
    POS_SERVICE_PASSWORD: string;
    MCP_JWT_SECRET: string;
    MCP_REDIS_URL: string;
    MCP_ALLOWED_ORIGINS: string;
    MCP_CLIENTS: {
        clientId: string;
        clientSecret: string;
        name: string;
        scopes: string[];
    }[];
};
export declare const allowedOrigins: Set<string>;
export type McpClientConfig = z.infer<typeof clientSchema>;
export {};
