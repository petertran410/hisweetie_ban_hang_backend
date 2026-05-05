import { Injectable } from '@nestjs/common';

interface CachedEntry {
  data: any;
  expiresAt: number;
}

@Injectable()
export class PermissionCacheService {
  private readonly cache = new Map<number, CachedEntry>();
  private readonly TTL_MS = 60_000;

  get(userId: number): any | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(userId);
      return null;
    }
    return entry.data;
  }

  set(userId: number, data: any): void {
    this.cache.set(userId, {
      data,
      expiresAt: Date.now() + this.TTL_MS,
    });
  }

  invalidateUser(userId: number): void {
    this.cache.delete(userId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
