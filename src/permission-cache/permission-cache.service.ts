import { Injectable } from '@nestjs/common';

interface CachedEntry {
  data: any;
  expiresAt: number;
}

@Injectable()
export class PermissionCacheService {
  private readonly cache = new Map<number, CachedEntry>();
  // Cache danh sách permission theo cặp user + chi nhánh (dùng cho PermissionsGuard).
  // Key: `${userId}:${branchId}`. Branch nằm trong key nên không lẫn quyền giữa các chi nhánh.
  private readonly branchCache = new Map<string, CachedEntry>();
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

  getBranch(userId: number, branchId: number): string[] | null {
    const key = `${userId}:${branchId}`;
    const entry = this.branchCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.branchCache.delete(key);
      return null;
    }
    return entry.data;
  }

  setBranch(userId: number, branchId: number, data: string[]): void {
    this.branchCache.set(`${userId}:${branchId}`, {
      data,
      expiresAt: Date.now() + this.TTL_MS,
    });
  }

  invalidateUser(userId: number): void {
    this.cache.delete(userId);
    // Xóa mọi entry branch-specific của user này (mọi chi nhánh).
    const prefix = `${userId}:`;
    for (const key of this.branchCache.keys()) {
      if (key.startsWith(prefix)) {
        this.branchCache.delete(key);
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear();
    this.branchCache.clear();
  }
}
