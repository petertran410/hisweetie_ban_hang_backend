import type { NextFunction, Request, Response } from 'express';
export declare function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void>;
