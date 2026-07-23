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
 * Lấy địa chỉ default (isDefault=true); nếu không có thì lấy bản đầu tiên (theo thứ tự
 * isDefault desc, createdAt asc — giống findOne/searchCustomers). Trả về snapshot 5 field
 * để ghi vào OrderDelivery/InvoiceDelivery.
 *
 * An toàn với mọi đầu vào:
 *  - customerId null/undefined → trả EMPTY_SNAPSHOT
 *  - khách không có địa chỉ → trả EMPTY_SNAPSHOT
 *  - địa chỉ thiếu field cũ/mới → field đó null (không crash)
 *
 * @param tx PrismaClient hoặc transaction client (tx từ $transaction)
 * @param customerId id khách hàng (nullable)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function resolveDeliveryAddress(
  tx: any,
  customerId?: number | null,
): Promise<DeliveryAddressSnapshot> {
  if (!customerId) return EMPTY_SNAPSHOT;

  const addr = await tx.customerAddress.findFirst({
    where: { customerId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    select: {
      cityName: true,
      districtName: true,
      wardName: true,
      newCityName: true,
      newWardName: true,
    },
  });

  if (!addr) return EMPTY_SNAPSHOT;

  return {
    oldCityName: addr.cityName ?? null,
    oldDistrictName: addr.districtName ?? null,
    oldWardName: addr.wardName ?? null,
    newCityName: addr.newCityName ?? null,
    newWardName: addr.newWardName ?? null,
  };
}
