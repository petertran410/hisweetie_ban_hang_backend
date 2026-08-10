export declare function posRequest<T>(method: string, path: string, options?: {
    query?: Record<string, unknown>;
    body?: unknown;
    branchId?: number;
}): Promise<T>;
