export declare function signWebhook(secret: string, timestamp: string, body: string): string;
export declare function verifyWebhook(secret: string, timestamp: string, body: string, signature: string): boolean;
