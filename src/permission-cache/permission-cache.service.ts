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
  // Cache response GET /auth/profile. Key: `${userId}:${branchId ?? ''}`.
  // Chỉ đọc sau JwtAuthGuard (đã kiểm isActive/permissionVersion) nên user bị
  // khóa không bao giờ chạm tới cache này.
  private readonly profileCache = new Map<string, CachedEntry>();
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

  getProfile(userId: number, branchId?: number): any | null {
    const key = `${userId}:${branchId ?? ''}`;
    const entry = this.profileCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.profileCache.delete(key);
      return null;
    }
    return entry.data;
  }

  setProfile(userId: number, branchId: number | undefined, data: any): void {
    this.profileCache.set(`${userId}:${branchId ?? ''}`, {
      data,
      expiresAt: Date.now() + this.TTL_MS,
    });
  }

  invalidateUser(userId: number): void {
    this.cache.delete(userId);
    // Xóa mọi entry branch-specific của user này (mọi chi nhánh).
    const prefix = `${userId}:`;
    for (const map of [this.branchCache, this.profileCache]) {
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) {
          map.delete(key);
        }
      }
    }
  }

  invalidateAll(): void {
    this.cache.clear();
    this.branchCache.clear();
    this.profileCache.clear();
  }
}
