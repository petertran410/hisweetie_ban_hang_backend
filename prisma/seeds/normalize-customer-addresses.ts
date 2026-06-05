/**
 * Chuẩn hoá dữ liệu địa chỉ trong bảng `customer_addresses` (model CustomerAddress).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BỐI CẢNH (đã khảo sát dữ liệu thật, 51.002 bản ghi):
 *   - Lọc contactNumber không trống còn ~23.815 bản ghi.
 *   - ~99,86% bản ghi KHÔNG có code hành chính nào, chỉ có `address` (text thô)
 *     và `locationName` dạng "{Tỉnh cũ} - {Quận cũ}".
 *   - DB dùng HỆ MÃ GSO/chính phủ (HCM=79, Hà Nội=01, ward mới 5 chữ số như
 *     27031). Repo Vietmap dùng hệ mã RIÊNG (HCM=12, ward=65803) → KHÔNG khớp DB.
 *
 * NGUỒN THAM CHIẾU (đặt trong prisma/seeds/data/address-ref/):
 *   - new-province-location.json   : 34 tỉnh mới, mã GSO  (source-of-truth khớp DB)
 *   - new-commune-location.json    : 3.321 phường/xã mới, mã GSO (khớp newWardCode DB)
 *   - old-location.json            : 63 tỉnh cũ, cấu trúc 3 cấp (validate địa chỉ cũ)
 *   - vietmap-old-to-new-mapping.json : mapping cũ→mới của Vietmap, CHỈ DÙNG CỘT
 *                                    TÊN (city_name_old/district_name_old/
 *                                    ward_name_old → city_name_new/ward_new_name).
 *                                    BỎ toàn bộ cột *_id_* của Vietmap (sai hệ mã).
 *
 * ĐƯỜNG ĐI MAPPING (đã kiểm chứng khả thi):
 *   address text  --parse-->  (tỉnh cũ, quận cũ, phường cũ)   [validate qua old-location]
 *      --vietmap (theo TÊN)-->  (tỉnh mới, phường mới)         [97% duy nhất, 2% split→review]
 *      --new-commune (theo TÊN)-->  newWardCode/newCityCode GSO [99,7% duy nhất]
 *
 * AN TOÀN:
 *   - DRY_RUN mặc định = true. KHÔNG gọi update khi dry-run.
 *   - Chỉ chạy update thật khi truyền đúng:  --confirm "Confirm update database"
 *   - Chỉ update 6 field cho phép: address, newCityCode, newCityName, newWardCode,
 *     newWardName, locationName. (updatedAt do Prisma tự set.)
 *   - Không tự đoán code; >1 candidate → needReview; không ghi đè new code hợp lệ.
 *
 * CÁCH CHẠY:
 *   yarn ts-node prisma/seeds/normalize-customer-addresses.ts            # dry-run (mặc định)
 *   yarn ts-node prisma/seeds/normalize-customer-addresses.ts --limit 500
 *   yarn ts-node prisma/seeds/normalize-customer-addresses.ts --confirm "Confirm update database"  # UPDATE THẬT
 */
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { Geocoder } from './lib/geocode';

dotenv.config({ path: join(process.cwd(), '.env') });

const prisma = new PrismaClient();

// ─────────────────────────── CONFIG ───────────────────────────
const args = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CONFIRM_TOKEN = 'Confirm update database';
const confirmArg = getFlag('--confirm');
// DRY_RUN chỉ tắt khi truyền đúng token. Không truyền → luôn dry-run.
const DRY_RUN = confirmArg !== CONFIRM_TOKEN;
const BATCH_SIZE = Number(getFlag('--batch') ?? 500);
const LIMIT = getFlag('--limit') ? Number(getFlag('--limit')) : undefined;

// ── Geocoding (pass 2) — mặc định TẮT để không tốn API. Chỉ chạy fallback cho
// record needReview có address. --geocode-limit giới hạn số record gọi API.
const GEOCODE = args.includes('--geocode');
const GEOCODE_LIMIT = getFlag('--geocode-limit') ? Number(getFlag('--geocode-limit')) : 200;
const TRACKASIA_API_KEY = process.env.TRACKASIA_API_KEY ?? '';
// Chỉ hoãn record hasNew sang pass geocode-verify khi THỰC SỰ có key (tránh
// thu thập rồi không xử lý được → mất record). Không có key → coi như --geocode tắt.
const GEOCODE_ACTIVE = GEOCODE && TRACKASIA_API_KEY.trim() !== '';

const DATA_DIR = join(process.cwd(), 'prisma/seeds/data/address-ref');
const OUT_DIR = join(process.cwd(), 'prisma/seeds/data');

// ─────────────────────── NORMALIZE TEXT ───────────────────────
// Trim → gộp space → lowercase → bỏ dấu → strip tiền tố hành chính.
// Dùng để SO KHỚP, không ghi vào DB.
// Lưu ý: dấu chấm đã được thay bằng space TRƯỚC khi strip, nên ở đây dùng dạng
// KHÔNG dấu chấm. Sắp xếp cụm dài trước (thanh pho, thi xa...) để ưu tiên match.
const ADMIN_PREFIXES = [
  'thanh pho',
  'thi xa',
  'thi tran',
  'tinh',
  'quan',
  'huyen',
  'phuong',
  'xa',
  'tp',
  'tx',
  'tt',
  'p',
  'q',
];

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function normalizeText(input?: string | null): string {
  if (!input) return '';
  let s = stripDiacritics(String(input)).toLowerCase();
  s = s.replace(/[.,\-]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  // strip admin prefix (chỉ ở đầu chuỗi)
  for (const p of ADMIN_PREFIXES) {
    if (s.startsWith(p + ' ')) {
      s = s.slice(p.length).trim();
      break;
    }
    if (s === p) return '';
  }
  return s.replace(/\s+/g, ' ').trim();
}

// alias tỉnh/thành hay gặp trong text thô (sau normalize)
const PROVINCE_ALIASES: Record<string, string> = {
  hcm: 'ho chi minh',
  tphcm: 'ho chi minh',
  'tp hcm': 'ho chi minh',
  'sai gon': 'ho chi minh',
  saigon: 'ho chi minh',
  hn: 'ha noi',
  'tp ha noi': 'ha noi',
  'ba ria vung tau': 'ba ria vung tau',
  brvt: 'ba ria vung tau',
};

// ─────────────────────── TYPES ───────────────────────
interface OldWard {
  provinceName: string;
  districtName: string;
  wardName: string;
}
interface NewCommune {
  code: string;
  name: string;
  provinceCode: string;
  provinceName: string;
}

// ─────────────────────── LOOKUPS ───────────────────────
type Stage =
  | 'LOAD_REFERENCE'
  | 'BUILD_LOOKUP'
  | 'QUERY_DB'
  | 'CLASSIFY'
  | 'NORMALIZE'
  | 'VALIDATE'
  | 'UPDATE';

const errors: { id?: number | string; error: string; stage: Stage }[] = [];

// oldLocation: tra cứu validate địa chỉ cũ
const oldProvinceNorms = new Set<string>(); // norm(province)
const oldDistrictByProvince = new Map<string, Set<string>>(); // provNorm -> set(distNorm)
const oldWardByProvDist = new Map<string, Set<string>>(); // provNorm|distNorm -> set(wardNorm)
// (provNorm|wardNorm) -> set(distNorm): để suy district CŨ khi district trong
// locationName đã sáp nhập/đổi tên (vd "Quận 9" → Thủ Đức) mà wardName còn định danh được.
const oldDistrictByProvWard = new Map<string, Set<string>>();
// map normalized → canonical name (để in matchedBy)
const oldProvinceCanon = new Map<string, string>();
const oldDistrictCanon = new Map<string, string>();
const oldWardCanon = new Map<string, string>();

// vietmap mapping: (provOldNorm|distOldNorm|wardOldNorm) → set "cityNew||wardNew"
const oldToNewMapping = new Map<string, Set<string>>();

// new commune: (wardNewNorm|provNewNorm) → set NewCommune
const newCommuneLookup = new Map<string, NewCommune[]>();
// new commune theo code GSO: wardCode → NewCommune (validate kết quả geocoding)
const newCommuneByCode = new Map<string, NewCommune>();
// new province: provNorm → {code,name}
const newProvinceLookup = new Map<string, { code: string; name: string }>();

function buildLookups() {
  // 1) old-location.json (nested)
  const oldLoc = JSON.parse(readFileSync(join(DATA_DIR, 'old-location.json'), 'utf8'));
  for (const prov of oldLoc) {
    const pN = normalizeText(prov.name);
    oldProvinceNorms.add(pN);
    oldProvinceCanon.set(pN, prov.name);
    for (const dist of prov.districts ?? []) {
      const dN = normalizeText(dist.name);
      if (!oldDistrictByProvince.has(pN)) oldDistrictByProvince.set(pN, new Set());
      oldDistrictByProvince.get(pN)!.add(dN);
      oldDistrictCanon.set(dN, dist.name);
      const key = `${pN}|${dN}`;
      for (const w of dist.wards ?? []) {
        const wN = normalizeText(w.name);
        if (!oldWardByProvDist.has(key)) oldWardByProvDist.set(key, new Set());
        oldWardByProvDist.get(key)!.add(wN);
        oldWardCanon.set(wN, w.name);
        const pwKey = `${pN}|${wN}`;
        if (!oldDistrictByProvWard.has(pwKey)) oldDistrictByProvWard.set(pwKey, new Set());
        oldDistrictByProvWard.get(pwKey)!.add(dN);
      }
    }
  }

  // 2) vietmap mapping (CHỈ tên)
  const vm = JSON.parse(readFileSync(join(DATA_DIR, 'vietmap-old-to-new-mapping.json'), 'utf8'));
  for (const r of vm) {
    const pN = normalizeText(r.city_name_old);
    const dN = normalizeText(r.district_name_old);
    const wN = normalizeText(r.ward_name_old);
    if (!pN || !dN || !wN) continue;
    const key = `${pN}|${dN}|${wN}`;
    const val = `${r.city_name_new}||${r.ward_new_name}`;
    if (!oldToNewMapping.has(key)) oldToNewMapping.set(key, new Set());
    oldToNewMapping.get(key)!.add(val);
  }

  // 3) new-commune-location.json
  const nc = JSON.parse(readFileSync(join(DATA_DIR, 'new-commune-location.json'), 'utf8'));
  for (const c of nc.communes) {
    const key = `${normalizeText(c.name)}|${normalizeText(c.provinceName)}`;
    if (!newCommuneLookup.has(key)) newCommuneLookup.set(key, []);
    const entry: NewCommune = {
      code: c.code,
      name: c.name,
      provinceCode: c.provinceCode,
      provinceName: c.provinceName,
    };
    newCommuneLookup.get(key)!.push(entry);
    newCommuneByCode.set(c.code, entry);
  }

  // 4) new-province-location.json
  const np = JSON.parse(readFileSync(join(DATA_DIR, 'new-province-location.json'), 'utf8'));
  for (const p of np.provinces) {
    newProvinceLookup.set(normalizeText(p.name), { code: p.code, name: p.name });
  }
}

// ─────────────────────── PARSE ĐỊA CHỈ CŨ TỪ TEXT ───────────────────────
// Trả về (provinceName, districtName, wardName) đã validate qua old-location,
// hoặc null nếu không xác định chắc chắn.
interface ParsedOld {
  provinceNorm: string;
  districtNorm: string;
  wardNorm: string;
  provinceCanon: string;
  districtCanon: string;
  wardCanon: string;
}

function resolveProvinceNorm(candidate: string): string | null {
  let c = candidate;
  if (PROVINCE_ALIASES[c]) c = PROVINCE_ALIASES[c];
  if (oldProvinceNorms.has(c)) return c;
  return null;
}

function parseOldAddress(addr: string, locationName: string): ParsedOld | null {
  // Gom segment từ address + locationName
  const addrParts = addr.split(',').map((s) => normalizeText(s)).filter(Boolean);
  const locParts = locationName.split(/[-,]/).map((s) => normalizeText(s)).filter(Boolean);
  const allParts = [...addrParts, ...locParts];

  // 1) Tỉnh: ưu tiên locationName (phần đầu thường là tỉnh cũ), fallback address.
  let provinceNorm: string | null = null;
  for (const p of [...locParts, ...addrParts.slice().reverse()]) {
    const r = resolveProvinceNorm(p);
    if (r) {
      provinceNorm = r;
      break;
    }
  }
  if (!provinceNorm) return null;

  // 2) Quận/huyện: trong các quận thuộc tỉnh đó.
  const dists = oldDistrictByProvince.get(provinceNorm);
  if (!dists) return null;
  let districtNorm: string | null = null;
  for (const p of allParts) {
    if (dists.has(p)) {
      districtNorm = p;
      break;
    }
  }
  if (!districtNorm) return null;

  // 3) Phường/xã: trong các phường thuộc (tỉnh,quận).
  const wards = oldWardByProvDist.get(`${provinceNorm}|${districtNorm}`);
  if (!wards) return null;
  let wardNorm: string | null = null;
  for (const p of addrParts) {
    if (wards.has(p)) {
      wardNorm = p;
      break;
    }
  }
  if (!wardNorm) return null;

  return {
    provinceNorm,
    districtNorm,
    wardNorm,
    provinceCanon: oldProvinceCanon.get(provinceNorm) ?? '',
    districtCanon: oldDistrictCanon.get(districtNorm) ?? '',
    wardCanon: oldWardCanon.get(wardNorm) ?? '',
  };
}

// Tách (province, district) từ locationName dạng "{Tỉnh cũ} - {Quận/Huyện cũ}".
// district = phần tử cuối; province = nối các phần đầu (giữ đúng tỉnh có dấu "-"
// như "Bà Rịa - Vũng Tàu"). Trả null nếu không đủ 2 cấp hoặc tỉnh không hợp lệ.
// districtValid = district có tồn tại trong old-location của tỉnh đó không (false
// nếu district đã sáp nhập/đổi tên, vd "Quận 9" → cần fallback qua wardName).
function parseProvinceDistrictFromLocation(
  locationName?: string | null,
): {
  provinceNorm: string;
  districtNorm: string;
  provinceCanon: string;
  districtCanon: string;
  districtValid: boolean;
} | null {
  if (!locationName) return null;
  const parts = locationName.split(' - ').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const districtRaw = parts[parts.length - 1];
  const provinceRaw = parts.slice(0, parts.length - 1).join(' - ');
  const provinceNorm = resolveProvinceNorm(normalizeText(provinceRaw));
  if (!provinceNorm) return null;
  const districtNorm = normalizeText(districtRaw);
  const dists = oldDistrictByProvince.get(provinceNorm);
  const districtValid = !!dists && dists.has(districtNorm);
  return {
    provinceNorm,
    districtNorm,
    provinceCanon: oldProvinceCanon.get(provinceNorm) ?? provinceRaw.trim(),
    districtCanon: districtValid ? oldDistrictCanon.get(districtNorm) ?? districtRaw.trim() : districtRaw.trim(),
    districtValid,
  };
}

// Tên phường/xã thuần SỐ (vd "1", "14") — KHÔNG dùng để quét substring trong
// address vì dễ trùng số nhà/tầng/số quận → false positive.
function isNumericWardName(norm: string): boolean {
  return /^\d+$/.test(norm.trim());
}

// Normalize TOÀN chuỗi (giữ nguyên thứ tự từ, chỉ bỏ dấu/gộp space) + pad 2 đầu
// để test substring theo ranh giới từ: hay.includes(" " + ward + " ").
function normalizeFull(input?: string | null): string {
  if (!input) return '';
  let s = stripDiacritics(String(input)).toLowerCase();
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return ` ${s} `;
}

// Bỏ TIỀN TỐ hành chính ở đầu chuỗi NHƯNG GIỮ NGUYÊN hoa/dấu phần còn lại — dùng
// để hiển thị (vd "Thị trấn Lai Uyên" → "Lai Uyên", "Phường 6" → "6"). Khác
// normalizeText (vốn bỏ dấu, lowercase — chỉ dùng để so khớp).
function stripAdminPrefixDisplay(input?: string | null): string {
  if (!input) return '';
  const s = String(input).trim();
  // alternation: cụm dài trước; \s+ bắt buộc có khoảng trắng sau tiền tố.
  const re =
    /^(Thành phố|Thị trấn|Thị xã|Tỉnh|Quận|Huyện|Phường|Xã|TP\.?|TX\.?|TT\.?|P\.?|Q\.?)\s+/i;
  const m = s.match(re);
  return m ? s.slice(m[0].length).trim() : s;
}

// Map 1 phường CŨ (prov,dist,ward đã normalize) sang địa chỉ mới 2 cấp.
// status: 'ok' (duy nhất), 'split' (>1 phường mới), 'none' (không map/không tra
// được code GSO duy nhất).
interface MapOldResult {
  status: 'ok' | 'split' | 'none';
  newCityCode?: string;
  newCityName?: string;
  newWardCode?: string;
  newWardName?: string;
}
function mapOldWardToNew(provNorm: string, distNorm: string, wardNorm: string): MapOldResult {
  const cands = oldToNewMapping.get(`${provNorm}|${distNorm}|${wardNorm}`);
  if (!cands || cands.size === 0) return { status: 'none' };
  if (cands.size > 1) return { status: 'split' };
  const [cityNew, wardNew] = [...cands][0].split('||');
  const nc = newCommuneLookup.get(`${normalizeText(wardNew)}|${normalizeText(cityNew)}`);
  if (!nc || nc.length === 0) return { status: 'none' };
  if (nc.length > 1) return { status: 'split' };
  const prov = newProvinceLookup.get(normalizeText(cityNew));
  return {
    status: 'ok',
    newCityCode: prov?.code ?? nc[0].provinceCode,
    newCityName: prov?.name ?? nc[0].provinceName,
    newWardCode: nc[0].code,
    newWardName: nc[0].name,
  };
}

// Liệt kê TẤT CẢ phường/xã MỚI mà 1 phường CŨ tách ra (dùng để định hướng khi
// status='split': nếu address chứa đúng tên 1 phường mới → giải nghĩa duy nhất).
function listNewCandidates(
  provNorm: string,
  distNorm: string,
  wardNorm: string,
): { newCityCode: string; newCityName: string; newWardCode: string; newWardName: string }[] {
  const cands = oldToNewMapping.get(`${provNorm}|${distNorm}|${wardNorm}`);
  if (!cands || cands.size === 0) return [];
  const out: { newCityCode: string; newCityName: string; newWardCode: string; newWardName: string }[] = [];
  const seen = new Set<string>();
  for (const pair of cands) {
    const [cityNew, wardNew] = pair.split('||');
    const nc = newCommuneLookup.get(`${normalizeText(wardNew)}|${normalizeText(cityNew)}`);
    if (!nc) continue;
    const prov = newProvinceLookup.get(normalizeText(cityNew));
    for (const entry of nc) {
      if (seen.has(entry.code)) continue;
      seen.add(entry.code);
      out.push({
        newCityCode: prov?.code ?? entry.provinceCode,
        newCityName: prov?.name ?? entry.provinceName,
        newWardCode: entry.code,
        newWardName: entry.name,
      });
    }
  }
  return out;
}

// ─────────────────────── CLEAN ADDRESS (mục 10) ───────────────────────
// Loại các segment là thành phần hành chính (cũ + mới). Giữ phần chi tiết.
function cleanAddress(addr: string, adminNorms: Set<string>): string {
  const parts = addr.split(',');
  const kept: string[] = [];
  for (const raw of parts) {
    const n = normalizeText(raw);
    if (!n) continue;
    // bỏ nếu khớp đúng 1 thành phần hành chính
    if (adminNorms.has(n)) continue;
    // bỏ nếu segment chỉ là tiền tố + tên hành chính (đã normalize cùng kết quả)
    kept.push(raw.trim());
  }
  let out = kept.join(', ');
  // dọn rác cuối: dấu phẩy/space thừa
  out = out.replace(/\s*,\s*,\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').replace(/\s+/g, ' ').trim();
  return out;
}

// ─────────────────────── MAIN ───────────────────────
interface PreviewChange {
  id: number;
  customerId: number;
  mappingSource: string;
  mappingConfidence: 'exact' | 'normalized_unique_match' | 'existing_new_address' | 'geocoded_unique_match';
  matchedBy: Record<string, string | null>;
  before: Record<string, any>;
  after: Record<string, any>;
  changedFields: string[];
  reason: string;
}
interface NeedReview {
  id: number;
  customerId: number;
  reason: string;
  currentData: Record<string, any>;
  note: string;
}

const NEW_FULL = (r: any) =>
  !!(r.newCityCode && r.newCityName && r.newWardCode && r.newWardName);
const OLD_FULL = (r: any) =>
  !!(r.cityCode && r.cityName && r.districtCode && r.districtName && r.wardCode && r.wardName);

function nonEmpty(v?: string | null): boolean {
  return v != null && String(v).trim() !== '';
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' NORMALIZE customer_addresses —', DRY_RUN ? 'DRY-RUN (không ghi DB)' : '⚠️  UPDATE THẬT');
  console.log(' batchSize =', BATCH_SIZE, LIMIT ? `| limit = ${LIMIT}` : '');
  console.log('═══════════════════════════════════════════════════════════');

  try {
    buildLookups();
    console.log('[BUILD_LOOKUP] old wards:', oldWardCanon.size, '| vietmap keys:', oldToNewMapping.size, '| new communes keys:', newCommuneLookup.size, '| new provinces:', newProvinceLookup.size);
  } catch (e: any) {
    errors.push({ error: e.message, stage: 'BUILD_LOOKUP' });
    console.error('[BUILD_LOOKUP] FAILED:', e.message);
    await prisma.$disconnect();
    process.exit(1);
  }

  // counters
  let total = 0;
  let withPhone = 0;
  let skippedNoPhone = 0;
  let cls_onlyOld = 0;
  let cls_both = 0;
  let cls_hasNew = 0;
  let cls_missing = 0;

  const preview: PreviewChange[] = [];
  const needReview: NeedReview[] = [];
  // record hasNew (đã có new code DB) — hoãn sang pass geocode-verify khi
  // GEOCODE_ACTIVE để đối chiếu sự thật địa lý trước khi tin new code DB.
  const hasNewToVerify: { id: number; customerId: number; before: Record<string, any> }[] = [];
  const reasonCount: Record<string, number> = {};
  const addReview = (nr: NeedReview) => {
    needReview.push(nr);
    reasonCount[nr.reason] = (reasonCount[nr.reason] ?? 0) + 1;
  };

  // total toàn bảng (để report)
  total = await prisma.customerAddress.count();

  // duyệt theo batch bằng cursor id; lọc contactNumber không trống ở mức query.
  let cursor: number | undefined = undefined;
  let processed = 0;

  while (true) {
    const batch: any[] = await prisma.customerAddress.findMany({
      where: {
        AND: [{ contactNumber: { not: null } }, { contactNumber: { not: '' } }],
      },
      // select tường minh: chỉ đọc cột cần thiết → không phụ thuộc cột geocode
      // (latitude/longitude/...) có thể CHƯA migrate vào DB đích. Các cột geocode
      // chỉ được GHI ở after.* khi --confirm, không bao giờ đọc từ record.
      select: {
        id: true,
        customerId: true,
        contactNumber: true,
        address: true,
        cityCode: true,
        cityName: true,
        districtCode: true,
        districtName: true,
        wardCode: true,
        wardName: true,
        newCityCode: true,
        newCityName: true,
        newWardCode: true,
        newWardName: true,
        locationName: true,
      },
      take: BATCH_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;

    for (const r of batch) {
      if (LIMIT && processed >= LIMIT) break;
      processed++;

      // double-check contactNumber (defensive)
      if (!nonEmpty(r.contactNumber)) {
        skippedNoPhone++;
        continue;
      }
      withPhone++;

      const before = {
        address: r.address,
        cityCode: r.cityCode,
        cityName: r.cityName,
        districtCode: r.districtCode,
        districtName: r.districtName,
        wardCode: r.wardCode,
        wardName: r.wardName,
        newCityCode: r.newCityCode,
        newCityName: r.newCityName,
        newWardCode: r.newWardCode,
        newWardName: r.newWardName,
        locationName: r.locationName,
      };

      try {
        // ── PHÂN LOẠI ──
        const hasNew = NEW_FULL(r);
        const hasOld = OLD_FULL(r);
        if (hasNew && hasOld) cls_both++;
        else if (hasNew) cls_hasNew++;
        else if (nonEmpty(r.cityCode) || nonEmpty(r.districtCode) || nonEmpty(r.wardCode)) cls_onlyOld++;
        else cls_missing++;

        // Kết quả new address để dùng chung
        let newCityCode = r.newCityCode as string | null;
        let newCityName = r.newCityName as string | null;
        let newWardCode = r.newWardCode as string | null;
        let newWardName = r.newWardName as string | null;
        let confidence: PreviewChange['mappingConfidence'] | null = null;
        const matchedBy: Record<string, string | null> = {};
        // tên hành chính CŨ đã parse (để loại khỏi address ở bước clean — mục 10)
        const parsedOldNames: string[] = [];

        if (hasNew) {
          // ── TH3: đã có new code đầy đủ → validate, KHÔNG ghi đè code ──
          //
          // Phần A — PHÁT HIỆN MÂU THUẪN NỘI TẠI (không cần API):
          // cityName (tỉnh CŨ trong DB) và tỉnh trong locationName (cũng hệ CŨ)
          // phải cùng chỉ một tỉnh; lệch nhau = dữ liệu hỏng, KHÔNG được tin new
          // code (vd #4: cityName HCM nhưng locationName "Hà Nội - Quận Hoàng Mai"
          // + address "Times City" → new code Tây Thạnh/HCM là rác).
          const locPD = parseProvinceDistrictFromLocation(r.locationName);
          const cityNameNorm = normalizeText(r.cityName);
          const dataConflict =
            !!locPD && cityNameNorm !== '' && cityNameNorm !== locPD.provinceNorm;

          if (dataConflict) {
            if (GEOCODE_ACTIVE) {
              // có API key → để pass geocode-verify quyết định (đè/giữ/review)
              hasNewToVerify.push({ id: r.id, customerId: r.customerId, before });
            } else {
              addReview({
                id: r.id,
                customerId: r.customerId,
                reason: 'DATA_CONFLICT',
                currentData: before,
                note: `Mâu thuẫn nội tại: cityName="${r.cityName}" ≠ tỉnh trong locationName="${locPD!.provinceCanon}". New code DB không đáng tin; cần geocode-verify (--geocode) hoặc xác minh thủ công.`,
              });
            }
            continue;
          }

          // KHÔNG mâu thuẫn → tin new code DB. CHỈ validate + chuẩn hoá, KHÔNG
          // geocode (tránh đè nhầm lên dữ liệu đã đúng; an toàn khi re-run sau khi
          // một phần record đã được ghi new code ở lần chạy trước).
          const key = `${normalizeText(newWardName)}|${normalizeText(newCityName)}`;
          const hit = newCommuneLookup.get(key);
          if (!hit || hit.length === 0) {
            addReview({
              id: r.id,
              customerId: r.customerId,
              reason: 'NEW_ADDRESS_VALIDATION_FAILED',
              currentData: before,
              note: `Địa chỉ mới hiện có không khớp new-commune-location.json (key="${key}").`,
            });
            continue;
          }
          confidence = 'existing_new_address';
          matchedBy.newWardName = newWardName;
          matchedBy.newCityName = newCityName;
        } else {
          // ── TH1/TH2 (đa số): suy ra new 2 cấp từ địa chỉ cũ ──
          //
          // Bước 1: xác định (tỉnh, quận) cũ theo độ tin cậy giảm dần:
          //   (a) old code/tên đầy đủ trong DB
          //   (b) parse từ locationName "{Tỉnh} - {Quận}"
          //   (c) parse từ address text (logic cũ)
          // Bước 2: xác định phường + map sang mới theo thứ tự:
          //   A: wardName DB là phường CŨ hợp lệ → old→new (ưu tiên cao nhất)
          //   B: wardName DB là phường MỚI hợp lệ → dùng trực tiếp
          //   D: wardName null → quét phường CŨ (tên chữ) là substring trong address → old→new
          //   C-new: wardName null → quét phường MỚI (tên chữ) là substring trong address
          let provinceNorm = '';
          let districtNorm = '';
          let provinceCanon = '';
          let districtCanon = '';
          let pdSource = '';

          if (hasOld) {
            provinceNorm = normalizeText(r.cityName);
            districtNorm = normalizeText(r.districtName);
            provinceCanon = r.cityName;
            districtCanon = r.districtName;
            pdSource = 'db.oldCode';
          } else {
            const fromLoc = parseProvinceDistrictFromLocation(r.locationName);
            if (fromLoc) {
              provinceNorm = fromLoc.provinceNorm;
              districtNorm = fromLoc.districtNorm;
              provinceCanon = fromLoc.provinceCanon;
              districtCanon = fromLoc.districtCanon;
              pdSource = 'locationName';
            } else {
              const fromAddr = parseOldAddress(r.address ?? '', r.locationName ?? '');
              if (fromAddr) {
                provinceNorm = fromAddr.provinceNorm;
                districtNorm = fromAddr.districtNorm;
                provinceCanon = fromAddr.provinceCanon;
                districtCanon = fromAddr.districtCanon;
                pdSource = 'address';
              }
            }
          }

          if (!provinceNorm || !districtNorm) {
            addReview({
              id: r.id,
              customerId: r.customerId,
              reason: nonEmpty(r.address) ? 'AMBIGUOUS_ADDRESS' : 'MISSING_OLD_ADDRESS_DATA',
              currentData: before,
              note: 'Không xác định được (tỉnh, quận) cũ từ DB/locationName/address.',
            });
            continue;
          }

          // Fallback district sáp nhập: nếu (tỉnh,quận) không có trong old-location
          // (vd "Quận 9" đã nhập vào Thủ Đức) nhưng wardName DB suy ra district CŨ
          // DUY NHẤT trong tỉnh đó → dùng district cũ thật để map chính xác.
          const wardNormForPD = normalizeText(r.wardName);
          if (
            wardNormForPD &&
            !oldWardByProvDist.has(`${provinceNorm}|${districtNorm}`)
          ) {
            const distSet = oldDistrictByProvWard.get(`${provinceNorm}|${wardNormForPD}`);
            if (distSet && distSet.size === 1) {
              districtNorm = [...distSet][0];
              districtCanon = oldDistrictCanon.get(districtNorm) ?? districtCanon;
              pdSource = `${pdSource}+wardResolvedDistrict`;
            }
          }

          matchedBy.oldCityName = provinceCanon;
          matchedBy.oldDistrictName = districtCanon;
          parsedOldNames.push(provinceCanon, districtCanon);

          const oldWards = oldWardByProvDist.get(`${provinceNorm}|${districtNorm}`);
          const wardNameNorm = normalizeText(r.wardName);
          let wardSource = '';
          let mapResult: MapOldResult | null = null;

          if (wardNameNorm) {
            // ── Path A: wardName DB là phường CŨ hợp lệ trong (tỉnh,quận) ──
            if (oldWards && oldWards.has(wardNameNorm)) {
              matchedBy.oldWardName = r.wardName;
              parsedOldNames.push(r.wardName);
              const res = mapOldWardToNew(provinceNorm, districtNorm, wardNameNorm);
              if (res.status === 'split') {
                // Phường cũ tách nhiều phường mới. Trước khi bỏ qua, thử định
                // hướng bằng address: nếu address chứa ĐÚNG tên 1 phường mới
                // (segment-exact hoặc substring tên-chữ) → giải nghĩa duy nhất.
                const splitCands = listNewCandidates(provinceNorm, districtNorm, wardNameNorm);
                const hay = normalizeFull(r.address);
                const addrSegs = new Set(
                  (r.address ?? '').split(',').map((s) => normalizeText(s)).filter(Boolean),
                );
                const matched = splitCands.filter((c) => {
                  const wn = normalizeText(c.newWardName);
                  if (!wn) return false;
                  if (addrSegs.has(wn)) return true;
                  if (!isNumericWardName(wn) && hay.includes(` ${wn} `)) return true;
                  return false;
                });
                const uniqByCode = new Map(matched.map((c) => [c.newWardCode, c]));
                if (uniqByCode.size === 1) {
                  const only = [...uniqByCode.values()][0];
                  mapResult = {
                    status: 'ok',
                    newCityCode: only.newCityCode,
                    newCityName: only.newCityName,
                    newWardCode: only.newWardCode,
                    newWardName: only.newWardName,
                  };
                  matchedBy.oldWardName = r.wardName;
                  matchedBy.splitResolvedByAddress = only.newWardName;
                  parsedOldNames.push(r.wardName);
                  wardSource = 'db.wardName(old)+splitAddrDisambig';
                  confidence = 'normalized_unique_match';
                } else {
                  addReview({
                    id: r.id, customerId: r.customerId,
                    reason: 'MULTIPLE_MAPPING_CANDIDATES', currentData: before,
                    note: `Phường cũ "${r.wardName}, ${districtCanon}, ${provinceCanon}" tách thành nhiều phường mới: ${splitCands.map((c) => c.newWardName).join(' | ')}.`,
                  });
                  continue;
                }
              }
              if (res.status === 'ok') { mapResult = res; wardSource = 'db.wardName(old)'; confidence = 'normalized_unique_match'; }
            }
            // ── Path B: wardName DB đã là phường MỚI hợp lệ trong tỉnh ──
            if (!mapResult) {
              const ncDirect = newCommuneLookup.get(`${wardNameNorm}|${provinceNorm}`);
              if (ncDirect && ncDirect.length === 1) {
                matchedBy.newWardName = r.wardName;
                parsedOldNames.push(r.wardName);
                const prov = newProvinceLookup.get(provinceNorm);
                mapResult = {
                  status: 'ok',
                  newCityCode: prov?.code ?? ncDirect[0].provinceCode,
                  newCityName: prov?.name ?? ncDirect[0].provinceName,
                  newWardCode: ncDirect[0].code,
                  newWardName: ncDirect[0].name,
                };
                wardSource = 'db.wardName(new)';
                confidence = 'existing_new_address';
              }
            }
          } else if (nonEmpty(r.address)) {
            // ── Path D: wardName null → tìm phường CŨ trong address ──
            // Lớp 1 (segment-exact): so khớp NGUYÊN segment (tách dấu phẩy) với tên
            //   phường cũ — AN TOÀN cho cả phường-số (vd segment "P6" → "6").
            // Lớp 2 (substring): chỉ phường tên-chữ là substring giữa chuỗi (vd
            //   "187 hoàng sa Tân định") — LOẠI phường-số để tránh false positive.
            const hay = normalizeFull(r.address);
            const addrSegs = new Set(
              (r.address as string).split(',').map((s) => normalizeText(s)).filter(Boolean),
            );
            const oldCodeMap = new Map<string, MapOldResult & { wardCanon: string }>();
            if (oldWards) {
              // Lớp 1: segment-exact (gồm phường-số)
              for (const w of oldWards) {
                if (!w || !addrSegs.has(w)) continue;
                const res = mapOldWardToNew(provinceNorm, districtNorm, w);
                if (res.status === 'ok') {
                  oldCodeMap.set(res.newWardCode!, { ...res, wardCanon: oldWardCanon.get(w) ?? w });
                }
              }
              // Lớp 2: substring (chỉ tên-chữ) — bổ sung nếu lớp 1 chưa tìm thấy
              if (oldCodeMap.size === 0) {
                for (const w of oldWards) {
                  if (!w || isNumericWardName(w)) continue;
                  if (!hay.includes(` ${w} `)) continue;
                  const res = mapOldWardToNew(provinceNorm, districtNorm, w);
                  if (res.status === 'ok') {
                    oldCodeMap.set(res.newWardCode!, { ...res, wardCanon: oldWardCanon.get(w) ?? w });
                  }
                }
              }
            }
            if (oldCodeMap.size === 1) {
              const only = [...oldCodeMap.values()][0];
              mapResult = only;
              matchedBy.oldWardName = only.wardCanon;
              parsedOldNames.push(only.wardCanon);
              wardSource = 'address.ward(old)';
              confidence = 'normalized_unique_match';
            } else if (oldCodeMap.size > 1) {
              addReview({
                id: r.id, customerId: r.customerId,
                reason: 'MULTIPLE_MAPPING_CANDIDATES', currentData: before,
                note: `Address chứa nhiều phường cũ map ra ${oldCodeMap.size} phường mới khác nhau.`,
              });
              continue;
            } else {
              // ── Path C-new: tìm phường MỚI trong address ──
              // CHỈ match khi tên phường mới xuất hiện kèm tiền tố cấp PHƯỜNG/XÃ
              // tường minh (phường/xã/thị trấn/p./tt.). KHÔNG match token trần,
              // tránh nhầm tên QUẬN thành phường (vd "Gò Vấp"→"Phường Gò Vấp").
              // Lưu ý: " xa <w> " phải loại trường hợp nằm trong " thi xa <w> "
              // (đơn vị cấp huyện) để khỏi nhầm "Thị Xã Sơn Tây" → "Phường Sơn Tây".
              const matchWardPrefix = (w: string): boolean => {
                if (hay.includes(` phuong ${w} `)) return true;
                if (hay.includes(` thi tran ${w} `)) return true;
                if (hay.includes(` tt ${w} `)) return true;
                if (hay.includes(` p ${w} `)) return true;
                // " xa <w> " nhưng KHÔNG phải " thi xa <w> "
                if (hay.includes(` xa ${w} `) && !hay.includes(` thi xa ${w} `)) return true;
                return false;
              };
              const newCodeMap = new Map<string, NewCommune>();
              for (const [k, arr] of newCommuneLookup) {
                if (!k.endsWith(`|${provinceNorm}`) || arr.length !== 1) continue;
                const wname = k.slice(0, k.length - provinceNorm.length - 1);
                if (!wname) continue;
                if (matchWardPrefix(wname)) newCodeMap.set(arr[0].code, arr[0]);
              }
              if (newCodeMap.size === 1) {
                const only = [...newCodeMap.values()][0];
                const prov = newProvinceLookup.get(provinceNorm);
                mapResult = {
                  status: 'ok',
                  newCityCode: prov?.code ?? only.provinceCode,
                  newCityName: prov?.name ?? only.provinceName,
                  newWardCode: only.code,
                  newWardName: only.name,
                };
                matchedBy.newWardName = only.name;
                parsedOldNames.push(only.name);
                wardSource = 'address.ward(new)';
                confidence = 'existing_new_address';
              } else if (newCodeMap.size > 1) {
                addReview({
                  id: r.id, customerId: r.customerId,
                  reason: 'MULTIPLE_MAPPING_CANDIDATES', currentData: before,
                  note: `Address chứa nhiều phường mới khác nhau trong ${provinceCanon}.`,
                });
                continue;
              }
            }
          }

          if (!mapResult) {
            addReview({
              id: r.id,
              customerId: r.customerId,
              reason: 'AMBIGUOUS_ADDRESS',
              currentData: before,
              note: `Xác định được (${districtCanon}, ${provinceCanon}) nhưng không tìm được phường mới duy nhất (source tỉnh/quận: ${pdSource}).`,
            });
            continue;
          }

          matchedBy.source = `${pdSource}+${wardSource}`;
          newCityCode = mapResult.newCityCode!;
          newCityName = mapResult.newCityName!;
          newWardCode = mapResult.newWardCode!;
          newWardName = mapResult.newWardName!;
        }

        // ── CHUẨN HOÁ address + locationName ──
        const adminNorms = new Set<string>();
        for (const v of [
          r.cityName,
          r.districtName,
          r.wardName,
          newCityName,
          newWardName,
          ...parsedOldNames,
        ]) {
          const n = normalizeText(v);
          if (n) adminNorms.add(n);
        }
        // thêm alias tỉnh để loại các biến thể (HCM, TPHCM...) trong address
        for (const [alias, canon] of Object.entries(PROVINCE_ALIASES)) {
          if (adminNorms.has(canon)) adminNorms.add(alias);
        }
        const cleanedAddressRaw = cleanAddress(r.address ?? '', adminNorms);
        let cleanedAddress = cleanedAddressRaw;

        if (nonEmpty(r.address) && !nonEmpty(cleanedAddress)) {
          // Address chỉ gồm thành phần hành chính → sau clean rỗng. Cứu bằng tên
          // phường/xã CŨ (bỏ tiền tố) làm locality chi tiết, vd "Thị trấn Lai
          // Uyên" → "Lai Uyên" — miễn nó KHÁC tên phường MỚI (tránh trùng lặp với
          // locationName). Đây là chi tiết hữu ích nhất khách hàng đã nhập.
          const oldWardCore = stripAdminPrefixDisplay(r.wardName);
          const differsFromNew =
            nonEmpty(oldWardCore) && normalizeText(oldWardCore) !== normalizeText(newWardName);
          if (differsFromNew) {
            cleanedAddress = oldWardCore;
          } else {
            addReview({
              id: r.id,
              customerId: r.customerId,
              reason: 'EMPTY_ADDRESS_AFTER_NORMALIZATION',
              currentData: before,
              note: 'Sau khi loại thành phần hành chính, address rỗng.',
            });
            continue;
          }
        }

        const desiredLocation =
          newWardName && newCityName ? `${newWardName}, ${newCityName}` : r.locationName;

        // ── Tính diff (chỉ field cho phép) ──
        const after: Record<string, any> = {};
        const changedFields: string[] = [];

        if (cleanedAddress !== r.address && nonEmpty(cleanedAddress)) {
          after.address = cleanedAddress;
          changedFields.push('address');
        }
        // new code: chỉ set khi record CHƯA có new đầy đủ (không ghi đè hợp lệ)
        if (!hasNew) {
          if (newCityCode !== r.newCityCode) { after.newCityCode = newCityCode; changedFields.push('newCityCode'); }
          if (newCityName !== r.newCityName) { after.newCityName = newCityName; changedFields.push('newCityName'); }
          if (newWardCode !== r.newWardCode) { after.newWardCode = newWardCode; changedFields.push('newWardCode'); }
          if (newWardName !== r.newWardName) { after.newWardName = newWardName; changedFields.push('newWardName'); }
        }
        // locationName: fill khi trống hoặc khác format chuẩn
        if (desiredLocation && desiredLocation !== r.locationName) {
          after.locationName = desiredLocation;
          changedFields.push('locationName');
        }

        if (changedFields.length === 0) {
          // không có gì để đổi → bỏ qua, không tính preview
          continue;
        }

        preview.push({
          id: r.id,
          customerId: r.customerId,
          mappingSource: 'vietmap-company/vietnam_administrative_address + pos new-commune (GSO)',
          mappingConfidence: confidence!,
          matchedBy,
          before,
          after,
          changedFields,
          reason:
            confidence === 'existing_new_address'
              ? 'Đã có địa chỉ mới hợp lệ; chỉ chuẩn hoá address/locationName.'
              : 'Suy ra địa chỉ mới 2 cấp từ địa chỉ cũ (mapping duy nhất).',
        });
      } catch (e: any) {
        errors.push({ id: r.id, error: e.message, stage: 'NORMALIZE' });
      }
    }

    if (LIMIT && processed >= LIMIT) break;
    process.stdout.write(`\r[QUERY_DB] processed ${processed} ...`);
  }
  process.stdout.write('\n');

  // ─────────────────────── PASS 2: GEOCODING FALLBACK ───────────────────────
  // Chỉ chạy khi --geocode. Geocode record needReview có address để PARSE ra
  // (tỉnh,quận,phường) CŨ, rồi đưa qua đúng pipeline mapOldWardToNew. Chỉ nhận
  // khi map DUY NHẤT (giữ nguyên tắc không tự đoán). Lưu lat/lng cho record nhận.
  let geocodeStats = { apiCalls: 0, cacheHits: 0, ok: 0, zeroResults: 0, errors: 0 };
  let geocodeResolved = 0;
  let geocodeConflict = 0;
  let geocodeAttempted = 0;
  const geocodeEnriched: any[] = []; // record có coords nhưng KHÔNG map duy nhất (để review)
  // Phần B — thống kê geocode-verify cho record hasNew (đã có new code DB).
  let hnVerified = 0; // số record hasNew đã geocode
  let hnKept = 0; // tỉnh khớp → giữ new code DB
  let hnOverridden = 0; // lệch tỉnh + chắc chắn → ghi đè bằng TrackAsia
  let hnReview = 0; // không chắc / lệch+partial / lỗi → review

  // Giữ new code DB (tỉnh khớp hoặc geocode không đủ chắc): validate code trong
  // GSO rồi chỉ chuẩn hoá address/locationName — y hệt nhánh hasNew gốc khi
  // KHÔNG bật geocode-verify.
  const keepHasNew = (
    h: { id: number; customerId: number; before: Record<string, any> },
    via: string,
  ): void => {
    const cur = h.before;
    const key = `${normalizeText(cur.newWardName)}|${normalizeText(cur.newCityName)}`;
    const hit = newCommuneLookup.get(key);
    if (!hit || hit.length === 0) {
      addReview({
        id: h.id, customerId: h.customerId, reason: 'NEW_ADDRESS_VALIDATION_FAILED', currentData: cur,
        note: `Địa chỉ mới hiện có không khớp new-commune-location.json (key="${key}").`,
      });
      hnReview++;
      return;
    }
    const adminNorms = new Set<string>();
    for (const v of [cur.cityName, cur.districtName, cur.wardName, cur.newCityName, cur.newWardName]) {
      const n = normalizeText(v);
      if (n) adminNorms.add(n);
    }
    for (const [alias, canon] of Object.entries(PROVINCE_ALIASES)) {
      if (adminNorms.has(canon)) adminNorms.add(alias);
    }
    const cleanedAddress = cleanAddress(cur.address ?? '', adminNorms);
    const desiredLocation =
      cur.newWardName && cur.newCityName ? `${cur.newWardName}, ${cur.newCityName}` : cur.locationName;
    const after: Record<string, any> = {};
    const changedFields: string[] = [];
    if (nonEmpty(cleanedAddress) && cleanedAddress !== cur.address) { after.address = cleanedAddress; changedFields.push('address'); }
    if (desiredLocation && desiredLocation !== cur.locationName) { after.locationName = desiredLocation; changedFields.push('locationName'); }
    hnKept++;
    if (changedFields.length === 0) return; // không có gì để đổi
    preview.push({
      id: h.id,
      customerId: h.customerId,
      mappingSource: 'vietmap-company/vietnam_administrative_address + pos new-commune (GSO)',
      mappingConfidence: 'existing_new_address',
      matchedBy: { newWardName: cur.newWardName, newCityName: cur.newCityName, verifiedVia: via },
      before: cur,
      after,
      changedFields,
      reason: `Đã có địa chỉ mới hợp lệ (geocode-verify: ${via}); chỉ chuẩn hoá address/locationName.`,
    });
  };

  if (GEOCODE) {
    if (!TRACKASIA_API_KEY) {
      errors.push({ error: 'Thiếu TRACKASIA_API_KEY trong .env', stage: 'NORMALIZE' });
      console.error('\n[GEOCODE] BỎ QUA: chưa cấu hình TRACKASIA_API_KEY.');
    } else {
      const geocoder = new Geocoder({
        apiKey: TRACKASIA_API_KEY,
        cachePath: join(OUT_DIR, 'geocode-cache.json'),
        reqPerSec: 8,
      });
      // ứng viên: needReview có address, reason có thể cứu bằng geocoding.
      const candidates = needReview.filter(
        (x) =>
          nonEmpty(x.currentData.address) &&
          ['AMBIGUOUS_ADDRESS', 'MULTIPLE_MAPPING_CANDIDATES', 'MISSING_OLD_ADDRESS_DATA'].includes(
            x.reason,
          ),
      );
      const slice = candidates.slice(0, GEOCODE_LIMIT);
      console.log(`\n[GEOCODE/TrackAsia] geocode ${slice.length}/${candidates.length} record (limit ${GEOCODE_LIMIT})...`);
      const resolvedIds = new Set<number>();

      for (let gi = 0; gi < slice.length; gi++) {
        const x = slice[gi];
        const cur = x.currentData;
        geocodeAttempted++;
        // ghép context: address + locationName (tỉnh/quận cũ) tăng độ chính xác
        const query = [cur.address, cur.locationName].filter(Boolean).join(', ');
        let g;
        try {
          g = await geocoder.geocode(query);
        } catch (e: any) {
          errors.push({ id: x.id, error: e.message, stage: 'NORMALIZE' });
          continue;
        }
        if (g.status !== 'OK') continue;

        // ── Validate: newWardCode/newCityCode TrackAsia phải tồn tại trong GSO ──
        const ncList = g.newWardCode ? newCommuneByCode.get(g.newWardCode) : undefined;
        if (!g.newWardCode || !g.newCityCode || !ncList) {
          geocodeEnriched.push({
            id: x.id, customerId: x.customerId, status: 'INVALID_OR_MISSING_CODE',
            geocoded: { wardCode: g.newWardCode, wardName: g.newWardName, cityCode: g.newCityCode, cityName: g.newCityName, lat: g.latitude, lng: g.longitude, partial: g.partialMatch },
          });
          continue;
        }
        // newCityCode phải khớp province của ward đó (chống lệch tỉnh/ward)
        if (ncList.provinceCode !== g.newCityCode) {
          geocodeEnriched.push({
            id: x.id, customerId: x.customerId, status: 'WARD_PROVINCE_MISMATCH',
            geocoded: { wardCode: g.newWardCode, cityCode: g.newCityCode, gsoProvinceOfWard: ncList.provinceCode, lat: g.latitude, lng: g.longitude },
          });
          continue;
        }

        // ── Cross-check tỉnh với locationName (nếu có) ──
        // locationName lưu tỉnh CŨ → so với CẢ tỉnh cũ lẫn tỉnh mới của geocode
        // (khớp 1 trong 2 là hợp lệ; xử lý đúng trường hợp tỉnh đã sáp nhập).
        const fromLoc = parseProvinceDistrictFromLocation(cur.locationName);
        const locProvNorm = fromLoc?.provinceNorm;
        const provinceMatches = locProvNorm
          ? locProvNorm === normalizeText(g.newCityName) ||
            locProvNorm === normalizeText(g.oldCityName)
          : null;
        if (locProvNorm && provinceMatches === false) {
          geocodeConflict++;
          geocodeEnriched.push({
            id: x.id, customerId: x.customerId, status: 'PROVINCE_CONFLICT',
            geocoded: { wardName: g.newWardName, cityName: g.newCityName, oldCityName: g.oldCityName, lat: g.latitude, lng: g.longitude },
            existingLocationName: cur.locationName,
          });
          continue;
        }

        // ── Ngưỡng 3a: fill khi (tỉnh khớp locationName) HOẶC (không partial_match) ──
        const accept = provinceMatches === true || g.partialMatch === false;
        if (!accept) {
          geocodeEnriched.push({
            id: x.id, customerId: x.customerId, status: 'LOW_CONFIDENCE_PARTIAL',
            geocoded: { wardName: g.newWardName, cityName: g.newCityName, lat: g.latitude, lng: g.longitude, partial: g.partialMatch },
          });
          continue;
        }

        // ── Chấp nhận → build preview, gỡ khỏi needReview ──
        const adminNorms = new Set<string>();
        for (const v of [cur.cityName, cur.districtName, cur.wardName, g.newCityName, g.newWardName]) {
          const n = normalizeText(v);
          if (n) adminNorms.add(n);
        }
        for (const [alias, canon] of Object.entries(PROVINCE_ALIASES)) {
          if (adminNorms.has(canon)) adminNorms.add(alias);
        }
        const cleanedAddress = cleanAddress(cur.address ?? '', adminNorms);
        const after: Record<string, any> = {};
        const changedFields: string[] = [];
        if (nonEmpty(cleanedAddress) && cleanedAddress !== cur.address) { after.address = cleanedAddress; changedFields.push('address'); }
        after.newCityCode = g.newCityCode; changedFields.push('newCityCode');
        after.newCityName = g.newCityName; changedFields.push('newCityName');
        after.newWardCode = g.newWardCode; changedFields.push('newWardCode');
        after.newWardName = g.newWardName; changedFields.push('newWardName');
        const desiredLoc = `${g.newWardName}, ${g.newCityName}`;
        if (desiredLoc !== cur.locationName) { after.locationName = desiredLoc; changedFields.push('locationName'); }
        // coords (factual từ geocoding)
        after.latitude = g.latitude ?? null; changedFields.push('latitude');
        after.longitude = g.longitude ?? null; changedFields.push('longitude');
        after.formattedAddress = g.formattedAddress ?? null; changedFields.push('formattedAddress');
        after.geocodeProvider = 'trackasia'; changedFields.push('geocodeProvider');
        after.geocodePrecision = g.partialMatch ? 'PARTIAL' : 'EXACT'; changedFields.push('geocodePrecision');
        after.geocodedAt = new Date(); changedFields.push('geocodedAt');

        preview.push({
          id: x.id,
          customerId: x.customerId,
          mappingSource: 'trackasia-search-v2 (official_id = GSO)',
          mappingConfidence: 'geocoded_unique_match',
          matchedBy: {
            source: `trackasia${g.partialMatch ? '(partial)' : ''}`,
            geocodedWard: g.newWardName ?? null,
            geocodedCity: g.newCityName ?? null,
            provinceCrossCheck: provinceMatches === true ? 'matched' : 'no_location_name',
          },
          before: x.currentData,
          after,
          changedFields,
          reason: 'Geocode TrackAsia → newWardCode/newCityCode (GSO) hợp lệ (kèm lat/lng).',
        });
        resolvedIds.add(x.id);
        geocodeResolved++;
      }

      // gỡ record đã resolve khỏi needReview + cập nhật reasonCount
      if (resolvedIds.size) {
        for (let i = needReview.length - 1; i >= 0; i--) {
          if (resolvedIds.has(needReview[i].id)) {
            reasonCount[needReview[i].reason] = (reasonCount[needReview[i].reason] ?? 1) - 1;
            needReview.splice(i, 1);
          }
        }
      }
      // ─────────────── PHẦN B: GEOCODE-VERIFY record hasNew ───────────────
      // Đối chiếu sự thật địa lý (TrackAsia, official_id=GSO) với new code DB.
      //  - Tỉnh khớp  → giữ new code DB, chỉ chuẩn hoá locationName (an toàn).
      //  - Lệch tỉnh + geocode CHẮC CHẮN (không partial) → ghi đè bằng TrackAsia.
      //  - Lệch + partial / không chắc / lỗi → đưa review (DATA_CONFLICT).
      if (hasNewToVerify.length) {
        console.log(`\n[GEOCODE/hasNew-verify] verify ${hasNewToVerify.length} record đã có new code DB...`);
        for (const h of hasNewToVerify) {
          const cur = h.before;
          hnVerified++;
          const query = [cur.address, cur.locationName].filter(Boolean).join(', ');
          let g;
          try {
            g = await geocoder.geocode(query);
          } catch (e: any) {
            errors.push({ id: h.id, error: e.message, stage: 'NORMALIZE' });
            addReview({
              id: h.id, customerId: h.customerId, reason: 'DATA_CONFLICT', currentData: cur,
              note: `Geocode lỗi khi verify new code DB: ${e.message}`,
            });
            hnReview++;
            continue;
          }

          // Geocode không ra kết quả dùng được → không đủ cơ sở đè. Nếu nội tại
          // mâu thuẫn thì phải review; nếu không thì giữ nguyên new code DB.
          const locPD = parseProvinceDistrictFromLocation(cur.locationName);
          const cityNameNorm = normalizeText(cur.cityName);
          const internalConflict = !!locPD && cityNameNorm !== '' && cityNameNorm !== locPD.provinceNorm;
          const ncList = g.status === 'OK' && g.newWardCode ? newCommuneByCode.get(g.newWardCode) : undefined;
          const geocodeUsable =
            g.status === 'OK' && !!g.newWardCode && !!g.newCityCode && !!ncList &&
            ncList.provinceCode === g.newCityCode;

          if (!geocodeUsable) {
            if (internalConflict) {
              geocodeEnriched.push({
                id: h.id, customerId: h.customerId, status: 'HASNEW_CONFLICT_GEOCODE_UNUSABLE',
                dbNew: { wardName: cur.newWardName, cityName: cur.newCityName },
                geocoded: { status: g.status, wardCode: g.newWardCode, cityName: g.newCityName, partial: g.partialMatch },
              });
              addReview({
                id: h.id, customerId: h.customerId, reason: 'DATA_CONFLICT', currentData: cur,
                note: `Mâu thuẫn nội tại (cityName="${cur.cityName}" ≠ locationName) và geocode không đủ chắc để ghi đè.`,
              });
              hnReview++;
            } else {
              // không mâu thuẫn, geocode yếu → tin new code DB, chỉ chuẩn hoá locationName
              keepHasNew(h, 'no_geocode');
            }
            continue;
          }

          // So tỉnh geocode (tỉnh MỚI) với tỉnh MỚI trong DB.
          const dbNewProvNorm = normalizeText(cur.newCityName);
          const gNewProvNorm = normalizeText(g.newCityName);
          const provinceMatches = dbNewProvNorm !== '' && dbNewProvNorm === gNewProvNorm;

          if (provinceMatches) {
            keepHasNew(h, 'geocode_province_match');
            continue;
          }

          // Lệch tỉnh → new code DB nghi rác. Chỉ ghi đè khi geocode CHẮC CHẮN.
          if (g.partialMatch === false) {
            const adminNorms = new Set<string>();
            for (const v of [cur.cityName, cur.districtName, cur.wardName, g.newCityName, g.newWardName]) {
              const n = normalizeText(v);
              if (n) adminNorms.add(n);
            }
            for (const [alias, canon] of Object.entries(PROVINCE_ALIASES)) {
              if (adminNorms.has(canon)) adminNorms.add(alias);
            }
            const cleanedAddress = cleanAddress(cur.address ?? '', adminNorms);
            const after: Record<string, any> = {};
            const changedFields: string[] = [];
            if (nonEmpty(cleanedAddress) && cleanedAddress !== cur.address) { after.address = cleanedAddress; changedFields.push('address'); }
            after.newCityCode = g.newCityCode; changedFields.push('newCityCode');
            after.newCityName = g.newCityName; changedFields.push('newCityName');
            after.newWardCode = g.newWardCode; changedFields.push('newWardCode');
            after.newWardName = g.newWardName; changedFields.push('newWardName');
            const desiredLoc = `${g.newWardName}, ${g.newCityName}`;
            if (desiredLoc !== cur.locationName) { after.locationName = desiredLoc; changedFields.push('locationName'); }
            after.latitude = g.latitude ?? null; changedFields.push('latitude');
            after.longitude = g.longitude ?? null; changedFields.push('longitude');
            after.formattedAddress = g.formattedAddress ?? null; changedFields.push('formattedAddress');
            after.geocodeProvider = 'trackasia'; changedFields.push('geocodeProvider');
            after.geocodePrecision = 'EXACT'; changedFields.push('geocodePrecision');
            after.geocodedAt = new Date(); changedFields.push('geocodedAt');
            preview.push({
              id: h.id,
              customerId: h.customerId,
              mappingSource: 'trackasia-search-v2 (official_id = GSO) — OVERRIDE new code DB rác',
              mappingConfidence: 'geocoded_unique_match',
              matchedBy: {
                source: 'trackasia',
                dbNewCity: cur.newCityName ?? null,
                geocodedCity: g.newCityName ?? null,
                geocodedWard: g.newWardName ?? null,
              },
              before: cur,
              after,
              changedFields,
              reason: `New code DB mâu thuẫn (DB="${cur.newCityName}" vs geocode="${g.newCityName}"); ghi đè bằng TrackAsia (GSO, không partial), kèm lat/lng.`,
            });
            hnOverridden++;
          } else {
            // lệch nhưng partial → không chắc, không tự đè → review
            geocodeEnriched.push({
              id: h.id, customerId: h.customerId, status: 'HASNEW_PROVINCE_CONFLICT_PARTIAL',
              dbNew: { wardName: cur.newWardName, cityName: cur.newCityName },
              geocoded: { wardName: g.newWardName, cityName: g.newCityName, lat: g.latitude, lng: g.longitude, partial: g.partialMatch },
            });
            addReview({
              id: h.id, customerId: h.customerId, reason: 'DATA_CONFLICT', currentData: cur,
              note: `New code DB lệch tỉnh với geocode (DB="${cur.newCityName}" vs geocode="${g.newCityName}") nhưng geocode partial → cần xác minh thủ công.`,
            });
            hnReview++;
          }
        }
        console.log(`[GEOCODE/hasNew-verify] xong. verified=${hnVerified}, kept=${hnKept}, overridden=${hnOverridden}, review=${hnReview}`);
      }

      geocoder.flush(true);
      geocodeStats = geocoder.stats;
      console.log(`[GEOCODE/TrackAsia] xong. resolved=${geocodeResolved}, conflict=${geocodeConflict}, enriched=${geocodeEnriched.length}, apiCalls=${geocodeStats.apiCalls}, cacheHits=${geocodeStats.cacheHits}`);
    }
  }

  // ─────────────────────── UPDATE THẬT (chỉ khi confirm) ───────────────────────
  let updated = 0;
  if (!DRY_RUN) {
    console.log(`\n⚠️  Bắt đầu UPDATE THẬT ${preview.length} bản ghi...`);
    for (let i = 0; i < preview.length; i += BATCH_SIZE) {
      const slice = preview.slice(i, i + BATCH_SIZE);
      try {
        await prisma.$transaction(
          slice.map((pc) =>
            prisma.customerAddress.update({
              where: { id: pc.id },
              data: pc.after, // chỉ chứa field cho phép
            }),
          ),
        );
        updated += slice.length;
        console.log(`  [UPDATE] batch ${i / BATCH_SIZE + 1}: ${slice.length} ok (tổng ${updated})`);
      } catch (e: any) {
        for (const pc of slice) errors.push({ id: pc.id, error: e.message, stage: 'UPDATE' });
        console.error(`  [UPDATE] batch ${i / BATCH_SIZE + 1} FAILED:`, e.message);
      }
    }
  }

  // ─────────────────────── REPORT ───────────────────────
  const report = {
    summary: {
      totalRecordsInTable: total,
      totalWithContactNumber: withPhone,
      skippedNoContactNumber: skippedNoPhone,
      normalizedInPreview: preview.length,
      needReview: needReview.length,
      dryRun: DRY_RUN,
      updatedReal: updated,
    },
    breakdown: {
      onlyOld3Level: cls_onlyOld,
      bothOldAndNew: cls_both,
      alreadyHasNew2Level: cls_hasNew,
      missingOrInvalid: cls_missing,
    },
    needReviewByReason: reasonCount,
    geocoding: GEOCODE
      ? {
          enabled: true,
          provider: 'trackasia-search-v2',
          attempted: geocodeAttempted,
          resolvedToPreview: geocodeResolved,
          provinceConflicts: geocodeConflict,
          enrichedButUnresolved: geocodeEnriched.length,
          apiCalls: geocodeStats.apiCalls,
          cacheHits: geocodeStats.cacheHits,
          ok: geocodeStats.ok,
          zeroResults: geocodeStats.zeroResults,
          providerErrors: geocodeStats.errors,
          hasNewVerify: {
            verified: hnVerified,
            keptDbNewCode: hnKept,
            overriddenByTrackAsia: hnOverridden,
            sentToReview: hnReview,
          },
        }
      : { enabled: false },
    errorsCount: errors.length,
  };

  writeFileSync(join(OUT_DIR, 'address-preview-changes.json'), JSON.stringify(preview, null, 2));
  writeFileSync(join(OUT_DIR, 'address-need-review.json'), JSON.stringify(needReview, null, 2));
  writeFileSync(join(OUT_DIR, 'address-normalize-report.json'), JSON.stringify(report, null, 2));
  if (GEOCODE) {
    writeFileSync(join(OUT_DIR, 'address-geocode-enriched.json'), JSON.stringify(geocodeEnriched, null, 2));
  }

  console.log('\n──────────────── SUMMARY ────────────────');
  console.log(JSON.stringify(report, null, 2));
  console.log('\nPreview changes (first 5):');
  console.log(JSON.stringify(preview.slice(0, 5), null, 2));
  console.log('\nNeed review (first 5):');
  console.log(JSON.stringify(needReview.slice(0, 5), null, 2));
  if (errors.length) {
    console.log('\nErrors (first 5):');
    console.log(JSON.stringify(errors.slice(0, 5), null, 2));
  }
  console.log('\nĐã ghi: address-preview-changes.json, address-need-review.json, address-normalize-report.json (prisma/seeds/data/)');
  console.log(DRY_RUN ? '\n✅ DRY-RUN: KHÔNG có thay đổi nào ghi vào DB.' : `\n⚠️  ĐÃ UPDATE ${updated} bản ghi.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  errors.push({ error: e.message, stage: 'QUERY_DB' });
  console.error('FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
