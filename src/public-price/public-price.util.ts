import {
  PRICE_GROUP_ICONS,
  PRICE_GROUP_MAX,
  PRICE_GROUPS,
  PRICE_REGION_KEYS,
  PRICE_TAGS,
  PriceGroupConfig,
  PriceGroupIcon,
  PricePageConfig,
  PriceRegionConfig,
  PriceRegionKey,
  PriceTag,
} from './public-price.types';

/** Bỏ dấu, chữ thường — để so khớp tên. */
export function norm(s: string | null | undefined): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Tách tên POS đầy đủ (như module Báo giá):
 * "Gấu Lermao - Mứt Đào Vàng 1kg (12 Túi/Thùng)" → { name: "Gấu Lermao - Mứt Đào Vàng 1kg", size: "1kg", spec: "12 Túi/Thùng", unit: "Túi" }.
 */
export function splitProductName(full: string): {
  name: string;
  size: string;
  spec: string;
  unit: string;
} {
  let name = full.trim();
  const spec = name.match(/\(([^()]*\/[^()]*)\)\s*$/)?.[1]?.trim() ?? '';
  if (spec) name = name.slice(0, name.lastIndexOf('(')).trim();
  const size =
    name.match(/(\d+(?:[.,]\d+)?\s*(?:kg|gr|g|ml|lít|l))\b/i)?.[1] ?? '';
  const unit = spec.match(/\d+\s*([^\d/]+?)\s*\//)?.[1]?.trim() ?? '';
  return { name, size, spec, unit };
}

/** Bỏ tiền tố thương hiệu "Gấu Lermao - " / "TRÀ PHƯỢNG HOÀNG - " khi trùng tên thương hiệu. */
export function stripBrandPrefix(
  name: string,
  brand: string | null | undefined,
): string {
  const i = name.indexOf(' - ');
  if (i <= 0 || !brand) return name;
  const head = norm(name.slice(0, i));
  const b = norm(brand);
  return head.includes(b) || b.includes(head) ? name.slice(i + 3).trim() : name;
}

/** Gợi ý kiểu nhóm khi thêm sản phẩm mới vào bảng giá. */
export function guessGroup(fullName: string): PriceGroupIcon {
  const n = norm(fullName);
  if (/tu dong|dong lanh/.test(n)) return 'froz';
  if (/\b(mut|siro|syrup|sot|puree)\b/.test(n)) return 'jam';
  if (/\bbot\b/.test(n)) return 'pow';
  if (/\b(tra|olong|o long|matcha|hong tra)\b/.test(n)) return 'tea';
  return 'top';
}

/** Tên hiển thị quen thuộc cho các thương hiệu chính. */
export function knownBrandLabel(tradeMarkName: string): string {
  const n = norm(tradeMarkName);
  if (n.includes('lermao')) return 'LerMao';
  if (n.includes('phuong hoang')) return 'Trà Phượng Hoàng';
  if (n.includes('amo')) return 'Amo Pastel';
  if (n.includes('natufruit')) return 'Natufruite';
  return tradeMarkName;
}

const str = (v: unknown, max = 500) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
const isDate = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
const posInt = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/** Link gắn vào nút trên trang public: chỉ nhận https:// (chặn javascript:, data:, http:…), sai → rỗng. */
export function httpsUrl(v: unknown, max = 300): string {
  const s = str(v, max);
  if (!s) return '';
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
}

export const DEFAULT_REGIONS: PriceRegionConfig[] = [
  {
    key: 'N',
    name: 'Miền Bắc',
    listName: 'Bảng giá chung',
    priceBookId: null,
    hotline: '0973 123 230',
    enabled: true,
  },
  {
    key: 'S',
    name: 'Miền Nam',
    listName: 'Bảng giá lẻ HCM',
    priceBookId: null,
    hotline: '',
    enabled: true,
  },
];

/**
 * Danh sách nhóm: bỏ mã sai/trùng, tối đa PRICE_GROUP_MAX. Cấu hình cũ chưa có `groups`
 * → các nhóm mặc định, nhóm nằm trong `hiddenGroups` cũ thì ẩn.
 */
function normalizeGroups(r: Record<string, unknown>): PriceGroupConfig[] {
  if (!Array.isArray(r.groups)) {
    const hidden = Array.isArray(r.hiddenGroups) ? r.hiddenGroups : [];
    return PRICE_GROUPS.map((g) => ({
      key: g.key,
      name: g.name,
      icon: g.key,
      visible: !hidden.includes(g.key),
    }));
  }
  const seen = new Set<string>();
  const groups = r.groups
    .map((g) =>
      g && typeof g === 'object' ? (g as Record<string, unknown>) : {},
    )
    .map((g) => ({
      key: typeof g.key === 'string' ? g.key : '',
      name: str(g.name, 40) || 'Nhóm sản phẩm',
      icon: (PRICE_GROUP_ICONS.includes(g.icon as PriceGroupIcon)
        ? g.icon
        : 'top') as PriceGroupIcon,
      visible: g.visible === undefined ? true : !!g.visible,
    }))
    .filter((g) => {
      if (!/^[a-z0-9]{1,24}$/.test(g.key) || seen.has(g.key)) return false;
      seen.add(g.key);
      return true;
    })
    .slice(0, PRICE_GROUP_MAX);
  return groups.length ? groups : normalizeGroups({});
}

/**
 * Chuẩn hoá cấu hình nhận từ POS (hoặc đọc từ DB): bỏ trường lạ, giới hạn độ dài,
 * bỏ sản phẩm/thương hiệu trùng. Không ném lỗi — giá trị sai thành mặc định.
 */
export function normalizeConfig(raw: unknown): PricePageConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const rawRegions = Array.isArray(r.regions) ? r.regions : [];
  const regions = DEFAULT_REGIONS.map((def) => {
    const x = (rawRegions.find(
      (y) =>
        y && typeof y === 'object' && (y as { key?: unknown }).key === def.key,
    ) ?? {}) as Record<string, unknown>;
    return {
      key: def.key,
      name: str(x.name, 40) || def.name,
      listName: str(x.listName, 80) || def.listName,
      priceBookId:
        x.priceBookId === null
          ? null
          : (posInt(x.priceBookId) ?? def.priceBookId),
      hotline: x.hotline === undefined ? def.hotline : str(x.hotline, 30),
      enabled: x.enabled === undefined ? true : !!x.enabled,
    };
  });
  const banner = (
    r.banner && typeof r.banner === 'object' ? r.banner : {}
  ) as Record<string, unknown>;

  const seenBrand = new Set<number>();
  const brands = (Array.isArray(r.brands) ? r.brands : [])
    .map((b) =>
      b && typeof b === 'object' ? (b as Record<string, unknown>) : {},
    )
    .map((b) => ({
      tradeMarkId: posInt(b.tradeMarkId),
      label: str(b.label, 60),
      visible: b.visible === undefined ? true : !!b.visible,
    }))
    .filter(
      (b): b is { tradeMarkId: number; label: string; visible: boolean } => {
        if (b.tradeMarkId == null || seenBrand.has(b.tradeMarkId)) return false;
        seenBrand.add(b.tradeMarkId);
        return true;
      },
    );

  const groups = normalizeGroups(r);
  const groupKeys = groups.map((g) => g.key);
  const seenItem = new Set<number>();
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((it) =>
      it && typeof it === 'object' ? (it as Record<string, unknown>) : {},
    )
    .map((it) => ({
      productId: posInt(it.productId),
      group:
        typeof it.group === 'string' && groupKeys.includes(it.group)
          ? it.group
          : groupKeys[0],
      visible: it.visible === undefined ? true : !!it.visible,
      tag: (PRICE_TAGS.includes(it.tag as PriceTag)
        ? it.tag
        : null) as PriceTag | null,
      hidePrice: (Array.isArray(it.hidePrice) ? it.hidePrice : []).filter(
        (k): k is PriceRegionKey =>
          PRICE_REGION_KEYS.includes(k as PriceRegionKey),
      ),
      name: str(it.name, 160),
      desc: str(it.desc, 500),
      imageId: posInt(it.imageId),
      brandId: posInt(it.brandId),
      size: str(it.size, 30),
      spec: str(it.spec, 60),
      unit: str(it.unit, 20),
    }))
    .filter((it): it is typeof it & { productId: number } => {
      if (it.productId == null || seenItem.has(it.productId)) return false;
      seenItem.add(it.productId);
      return true;
    })
    .slice(0, 500);

  return {
    regions,
    zaloUrl: httpsUrl(r.zaloUrl),
    banner: {
      enabled: !!banner.enabled,
      tag: str(banner.tag, 40),
      text: str(banner.text, 200),
    },
    validFrom: isDate(r.validFrom),
    validTo: isDate(r.validTo),
    groups,
    brands,
    items,
  };
}
