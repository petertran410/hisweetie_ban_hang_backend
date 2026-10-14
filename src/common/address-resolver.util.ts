/**
 * Kết quả resolve địa chỉ giao hàng từ customer_addresses.
 * Snapshot cả địa chỉ cũ (3 cấp) lẫn mới (2 cấp) để lưu vào OrderDelivery/InvoiceDelivery,
 * giúp nhân viên giao hàng xem được cả hai loại địa chỉ.
 */
export interface DeliveryAddressSnapshot {
  oldCityName: string | null;
  oldDistrictName: string | null;
  oldWardName: string | null;
  newCityName: string | null;
  newWardName: string | null;
}

/** Thông tin địa chỉ giao hàng dùng để dò đúng địa chỉ của khách. */
export interface DeliveryAddressHint {
  address?: string | null;
  wardName?: string | null;
  newWardName?: string | null;
}

interface CustomerAddressLike {
  address?: string | null;
  wardName?: string | null;
  newWardName?: string | null;
  isDefault?: boolean | null;
}

/**
 * Chọn địa chỉ của khách ứng với địa chỉ giao hàng: khớp số nhà/đường → khớp
 * phường (mới hoặc cũ) → địa chỉ mặc định → địa chỉ đầu tiên.
 */
export function pickCustomerAddress<T extends CustomerAddressLike>(
  addresses: T[] | null | undefined,
  delivery?: DeliveryAddressHint | null,
): T | null {
  if (!addresses?.length) return null;
  const norm = (v?: string | null) => (v || '').trim().toLowerCase();

  if (delivery) {
    const street = norm(delivery.address);
    const byStreet =
      street && addresses.find((a) => norm(a.address) === street);
    if (byStreet) return byStreet;

    const wards = [delivery.newWardName, delivery.wardName]
      .map(norm)
      .filter(Boolean);
    const byWard =
      wards.length > 0 &&
      addresses.find(
        (a) =>
          wards.includes(norm(a.newWardName)) ||
          wards.includes(norm(a.wardName)),
      );
    if (byWard) return byWard;
  }

  return addresses.find((a) => a.isDefault) ?? addresses[0];
}

const EMPTY_SNAPSHOT: DeliveryAddressSnapshot = {
  oldCityName: null,
  oldDistrictName: null,
  oldWardName: null,
  newCityName: null,
  newWardName: null,
};

/**
 * Resolve địa chỉ giao hàng (cả cũ + mới) từ customer_addresses của khách.
 *
 * Lấy địa chỉ của khách khớp với địa chỉ giao hàng (pickCustomerAddress); không
 * truyền delivery / không khớp → địa chỉ default, rồi bản đầu tiên (isDefault desc,
 * createdAt asc). Trả về snapshot 5 field để ghi vào OrderDelivery/InvoiceDelivery.
 *
 * An toàn với mọi đầu vào:
 *  - customerId null/undefined → trả EMPTY_SNAPSHOT
 *  - khách không có địa chỉ → trả EMPTY_SNAPSHOT
 *  - địa chỉ thiếu field cũ/mới → field đó null (không crash)
 *
 * @param tx PrismaClient hoặc transaction client (tx từ $transaction)
 * @param customerId id khách hàng (nullable)
 * @param delivery địa chỉ giao hàng đang lưu (để chụp đúng địa chỉ, không phải default)
 */

export async function resolveDeliveryAddress(
  tx: any,
  customerId?: number | null,
  delivery?: DeliveryAddressHint | null,
): Promise<DeliveryAddressSnapshot> {
  if (!customerId) return EMPTY_SNAPSHOT;

  const addresses: any[] = await tx.customerAddress.findMany({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: {
      address: true,
      isDefault: true,
      cityName: true,
      districtName: true,
      wardName: true,
      newCityName: true,
      newWardName: true,
    },
  });
  const addr = pickCustomerAddress(addresses, delivery);

  if (!addr) return EMPTY_SNAPSHOT;

  return {
    oldCityName: addr.cityName ?? null,
    oldDistrictName: addr.districtName ?? null,
    oldWardName: addr.wardName ?? null,
    newCityName: addr.newCityName ?? null,
    newWardName: addr.newWardName ?? null,
  };
}
