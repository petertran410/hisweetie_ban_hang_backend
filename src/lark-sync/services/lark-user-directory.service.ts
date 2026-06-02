import { Injectable, Inject, Logger } from '@nestjs/common';
import * as lark from '@larksuiteoapi/node-sdk';
import { LARK_CLIENT } from '../lark-client.provider';

/**
 * Build cache "tên Lark user → open_id" qua Lark Contact API:
 * 1. contact.scope.list → list department_ids + user_ids trong scope của bot
 * 2. Mỗi department: contact.user.findByDepartment → list user
 * 3. Cộng thêm các user_ids đứng ngoài department (scope cá nhân)
 *
 * Lý do không scan cột "Người Chi" của Base nữa: user mới (vd Nguyễn Toàn —
 * chỉ là Người Tạo, chưa từng là Người Chi) sẽ không có trong cache.
 *
 * Match: lowercase + trim + dấu cách bình thường (giữ dấu tiếng Việt).
 */
@Injectable()
export class LarkUserDirectoryService {
  private readonly logger = new Logger(LarkUserDirectoryService.name);

  /** Map normalized-name → open_id */
  private cache: Map<string, string> | null = null;
  private cacheBuiltAt = 0;
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1h
  private buildPromise: Promise<Map<string, string>> | null = null;

  constructor(@Inject(LARK_CLIENT) private readonly client: lark.Client) {}

  /**
   * Tìm open_id theo tên người (case-insensitive, bỏ khoảng trắng thừa).
   * Trả về null nếu không khớp hoặc cache build lỗi.
   */
  async findOpenIdByName(name?: string | null): Promise<string | null> {
    if (!name) return null;
    const key = this.normalize(name);
    if (!key) return null;

    const cache = await this.ensureCache();
    return cache.get(key) || null;
  }

  /** Force refresh cache (gọi từ controller nếu cần). */
  async refresh(): Promise<void> {
    this.cache = null;
    this.cacheBuiltAt = 0;
    await this.ensureCache();
  }

  private async ensureCache(): Promise<Map<string, string>> {
    const now = Date.now();
    if (this.cache && now - this.cacheBuiltAt < this.CACHE_TTL_MS) {
      return this.cache;
    }
    if (this.buildPromise) {
      return this.buildPromise;
    }

    this.buildPromise = this.buildCache()
      .then((map) => {
        this.cache = map;
        this.cacheBuiltAt = Date.now();
        return map;
      })
      .finally(() => {
        this.buildPromise = null;
      });

    return this.buildPromise;
  }

  private async buildCache(): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    const departmentIds: string[] = [];
    const looseUserIds: string[] = [];

    try {
      let pageToken: string | undefined;

      while (true) {
        const res: any = await this.client.contact.scope.list({
          params: {
            user_id_type: 'open_id',
            department_id_type: 'open_department_id',
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });

        if (res?.code && res.code !== 0) {
          this.logger.warn(
            `contact.scope.list code=${res.code} msg=${res.msg}`,
          );
          break;
        }

        departmentIds.push(...(res?.data?.department_ids || []));
        looseUserIds.push(...(res?.data?.user_ids || []));

        if (!res?.data?.has_more) break;
        pageToken = res?.data?.page_token;
      }
    } catch (err: any) {
      this.logger.error(`contact.scope.list lỗi: ${err.message}`);
      return map;
    }

    // 2. Lấy user theo từng department
    for (const dept of departmentIds) {
      let pageToken: string | undefined;

      while (true) {
        try {
          const res: any = await this.client.contact.user.findByDepartment({
            params: {
              user_id_type: 'open_id',
              department_id_type: 'open_department_id',
              department_id: dept,
              page_size: 50,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          });

          if (res?.code && res.code !== 0) {
            this.logger.warn(
              `findByDepartment dept=${dept} code=${res.code} msg=${res.msg}`,
            );
            break;
          }

          const items = res?.data?.items || [];
          for (const u of items) {
            this.addUser(map, u);
          }

          if (!res?.data?.has_more) break;
          pageToken = res?.data?.page_token;
        } catch (err: any) {
          this.logger.error(
            `findByDepartment dept=${dept} lỗi: ${err.message}`,
          );
          break;
        }
      }
    }

    // 3. Lấy thêm user lẻ trong scope (không thuộc department được uỷ quyền)
    for (const openId of looseUserIds) {
      try {
        const res: any = await this.client.contact.user.get({
          path: { user_id: openId },
          params: { user_id_type: 'open_id' },
        });
        if (res?.code === 0 && res?.data?.user) {
          this.addUser(map, res.data.user);
        }
      } catch (err: any) {
        this.logger.warn(`contact.user.get ${openId} lỗi: ${err.message}`);
      }
    }

    this.logger.log(
      `Lark user cache built: ${map.size} unique names from ${departmentIds.length} depts + ${looseUserIds.length} loose users`,
    );
    return map;
  }

  private addUser(map: Map<string, string>, u: any): void {
    const openId = u?.open_id;
    if (typeof openId !== 'string') return;
    const candidates = [u?.name, u?.en_name, u?.nickname].filter(
      (n): n is string => typeof n === 'string' && n.length > 0,
    );
    for (const name of candidates) {
      const key = this.normalize(name);
      if (key && !map.has(key)) {
        map.set(key, openId);
      }
    }
  }

  private normalize(s: string): string {
    return s.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
  }
}
