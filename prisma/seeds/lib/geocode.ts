/**
 * Module geocoding dùng TrackAsia Search V2 (forward geocoding).
 *
 * Endpoint: https://maps.track-asia.com/api/v2/place/textsearch/json
 * Ưu điểm: trả thẳng địa giới MỚI theo mã hành chính chuẩn quốc gia (GSO) qua
 * `official_id` của mỗi address_component — khớp trực tiếp new-commune-location.json
 * mà KHÔNG cần map qua Vietmap. Có sẵn lat/lng và cờ partial_match.
 *
 * - Cần TRACKASIA_API_KEY trong .env (public_key chỉ để test, bị giới hạn).
 * - Cache file (geocode-cache.json) để chạy lại KHÔNG tốn quota.
 * - Throttle + retry/backoff.
 *
 * official_id mapping (đã xác minh với new-commune-location.json):
 *   - administrative_area_level_1 → tỉnh/thành: official_id = newCityCode (vd "79","01")
 *   - administrative_area_level_2 hoặc _3 → phường/xã: official_id = newWardCode (vd "26737","00322")
 */
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const SEARCH_URL = 'https://maps.track-asia.com/api/v2/place/textsearch/json';

export interface GeocodeResult {
  status: string; // OK | ZERO_RESULTS | ERROR: ...
  newCityCode?: string; // official_id của administrative_area_level_1
  newCityName?: string;
  newWardCode?: string; // official_id của administrative_area_level_2|3
  newWardName?: string;
  oldCityName?: string; // tỉnh CŨ (old_address_components) — để cross-check với locationName
  latitude?: number;
  longitude?: number;
  partialMatch?: boolean;
  formattedAddress?: string;
  fromCache?: boolean;
}

type CacheEntry = Omit<GeocodeResult, 'fromCache'>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Geocoder {
  private apiKey: string;
  private cachePath: string;
  private cache: Map<string, CacheEntry> = new Map();
  private minIntervalMs: number;
  private lastCallAt = 0;
  private cacheDirty = 0;

  public stats = { apiCalls: 0, cacheHits: 0, ok: 0, zeroResults: 0, errors: 0 };

  constructor(opts: { apiKey: string; cachePath: string; reqPerSec?: number }) {
    this.apiKey = opts.apiKey;
    this.cachePath = opts.cachePath;
    this.minIntervalMs = Math.ceil(1000 / (opts.reqPerSec ?? 8));
    if (existsSync(this.cachePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.cachePath, 'utf8'));
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v as CacheEntry);
      } catch {
        /* cache hỏng → bỏ qua */
      }
    }
  }

  private cacheKey(query: string): string {
    return query.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  flush(force = false): void {
    if (!force && this.cacheDirty < 25) return;
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of this.cache) obj[k] = v;
    writeFileSync(this.cachePath, JSON.stringify(obj));
    this.cacheDirty = 0;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.lastCallAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }

  // Lấy component theo type ưu tiên (level_2 trước, fallback level_3) cho phường/xã.
  private pickComponent(components: any[], types: string[]): any | undefined {
    for (const t of types) {
      const hit = components.find((c) => Array.isArray(c.types) && c.types.includes(t));
      if (hit) return hit;
    }
    return undefined;
  }

  private parseResult(result: any): Omit<CacheEntry, 'status'> {
    const out: Omit<CacheEntry, 'status'> = {};
    const comps: any[] = result.address_components ?? [];
    const prov = this.pickComponent(comps, ['administrative_area_level_1']);
    // phường/xã mới: TrackAsia đặt ở level_2 (đã xác minh), fallback level_3
    const ward = this.pickComponent(comps, ['administrative_area_level_2', 'administrative_area_level_3']);
    if (prov?.official_id) {
      out.newCityCode = String(prov.official_id);
      out.newCityName = prov.long_name;
    }
    if (ward?.official_id) {
      out.newWardCode = String(ward.official_id);
      out.newWardName = ward.long_name;
    }
    // tỉnh CŨ (theo địa giới cũ) để cross-check với locationName (vốn lưu tỉnh cũ)
    const oldComps: any[] = result.old_address_components ?? [];
    const oldProv = this.pickComponent(oldComps, ['administrative_area_level_1']);
    if (oldProv?.long_name) out.oldCityName = oldProv.long_name;
    const loc = result.geometry?.location;
    if (loc) {
      out.latitude = loc.lat;
      out.longitude = loc.lng;
    }
    out.partialMatch = !!result.partial_match;
    out.formattedAddress = result.formatted_address;
    return out;
  }

  async geocode(query: string): Promise<GeocodeResult> {
    const key = this.cacheKey(query);
    if (this.cache.has(key)) {
      this.stats.cacheHits++;
      return { ...this.cache.get(key)!, fromCache: true };
    }

    let attempt = 0;
    while (attempt < 4) {
      attempt++;
      await this.throttle();
      try {
        this.stats.apiCalls++;
        const resp = await axios.get(SEARCH_URL, {
          params: {
            query,
            key: this.apiKey,
            language: 'vi',
            new_admin: 'true',
            include_old_admin: 'true',
          },
          timeout: 20000,
        });
        const status: string = resp.data?.status;
        if (status !== 'OK' || !resp.data.results?.length) {
          if (status === 'ZERO_RESULTS') this.stats.zeroResults++;
          else this.stats.errors++;
          const entry: CacheEntry = { status: status ?? 'UNKNOWN' };
          this.cache.set(key, entry);
          this.cacheDirty++;
          this.flush();
          return { ...entry };
        }
        this.stats.ok++;
        const parsed = this.parseResult(resp.data.results[0]);
        const entry: CacheEntry = { status: 'OK', ...parsed };
        this.cache.set(key, entry);
        this.cacheDirty++;
        this.flush();
        return { ...entry };
      } catch (e: any) {
        const code = e.response?.status;
        // 429/5xx → backoff rồi thử lại
        if (attempt < 4 && (code === 429 || code === undefined || (code >= 500 && code < 600))) {
          await sleep(800 * attempt * attempt);
          continue;
        }
        this.stats.errors++;
        return { status: `ERROR: ${code ?? e.message}` };
      }
    }
    this.stats.errors++;
    return { status: 'ERROR: max_retries' };
  }
}
