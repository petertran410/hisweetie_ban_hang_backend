import type { Request, Response } from 'express';
export declare function listSubscriptions(req: Request, res: Response): Promise<void>;
export declare function createSubscription(req: Request, res: Response): Promise<void>;
export declare function deleteSubscription(req: Request, res: Response): Promise<void>;
