import type { NextFunction, Request, Response } from 'express';
import { type McpClientConfig } from './config.js';
export interface AuthContext {
    clientId: string;
    clientName: string;
    scopes: string[];
}
declare global {
    namespace Express {
        interface Request {
            mcpAuth?: AuthContext;
        }
    }
}
export declare function issueAccessToken(client: McpClientConfig): Promise<string>;
export declare function tokenEndpoint(req: Request, res: Response): Promise<void>;
export declare function requireBearer(req: Request, res: Response, next: NextFunction): Promise<void>;
export declare function requireScope(req: Request, scope: string): void;
