/**
 * Tính VAT theo cách Misa AMIS — dùng chung giữa:
 *  - misa-voucher.service.ts (đẩy chứng từ thật lên Misa)
 *  - invoices.service.ts findAllVat/getVatTotals (trang /don-hang/hoa-don-vat)
 *
 * Logic bê nguyên từ misa-voucher.service.ts (buildVoucherPayload) để
 * số liệu trang list và voucher thật KHÔNG bao giờ lệch nhau.
 */

export const MISA_VAT_RATE = 8;

export interface VatComputableLine {
  quantity: VatNumeric;
  price: VatNumeric;
  discount?: VatNumeric | null;
}

/** Chấp nhận cả Prisma Decimal (có toString/valueOf) lẫn number/string. */
export type VatNumeric = number | string | { toString(): string };

export interface VatLineResult {
  /** Đơn giá đã gồm thuế sau khi trừ chiết khấu (price - discount) */
  unitPriceAfterTax: number;
  /** Đơn giá trước thuế (đã bóc VAT) */
  unitPrice: number;
  /** Thành tiền trước thuế của dòng */
  amountBeforeTax: number;
  /** Tiền thuế VAT của dòng */
  vatAmount: number;
  /** Thành tiền sau thuế của dòng */
  amountAfterTax: number;
}

export interface InvoiceVatResult {
  lines: VatLineResult[];
  totalPreTax: number;
  totalVat: number;
  totalAfterTax: number;
}

/**
 * Tính VAT cho 1 dòng hàng. Công thức y hệt misa-voucher.service.ts:
 *  - unitPrice (trước thuế)   = round((price - discount) / (1 + rate/100), 2)
 *  - amountBeforeTax          = round(unitPrice * quantity)
 *  - vatAmount                = trunc(amountBeforeTax * rate / 100)
 */
export function computeLineVat(
  line: VatComputableLine,
  vatRate: number = MISA_VAT_RATE,
): VatLineResult {
  const quantity = Number(line.quantity);
  const originalPrice = Number(line.price);
  const discountAmount = Number(line.discount || 0);

  const unitPriceAfterTax = originalPrice - discountAmount;
  const unitPrice =
    Math.round((unitPriceAfterTax / (1 + vatRate / 100)) * 100) / 100;
  const amountBeforeTax = Math.round(unitPrice * quantity);
  const vatAmount = Math.trunc((amountBeforeTax * vatRate) / 100);
  const amountAfterTax = amountBeforeTax + vatAmount;

  return {
    unitPriceAfterTax,
    unitPrice,
    amountBeforeTax,
    vatAmount,
    amountAfterTax,
  };
}

/**
 * Tính tổng VAT cho toàn hóa đơn + áp fix-up chênh lệch VAT lên dòng đầu
 * (giống misa-voucher.service.ts). Chỉ tính trên các dòng truyền vào — bên
 * gọi nên lọc dòng có misa_code trước nếu muốn khớp tuyệt đối với voucher.
 */
export function computeInvoiceVat(
  lines: VatComputableLine[],
  vatRate: number = MISA_VAT_RATE,
): InvoiceVatResult {
  const lineResults: VatLineResult[] = [];
  let totalPreTax = 0;
  let totalVat = 0;
  let totalAfterTax = 0;

  for (const line of lines) {
    const result = computeLineVat(line, vatRate);
    lineResults.push(result);
    totalPreTax += result.amountBeforeTax;
    totalVat += result.vatAmount;
    totalAfterTax += result.amountAfterTax;
  }

  // Fix-up chênh lệch VAT dồn vào dòng đầu (total_discount_amount = 0)
  if (lineResults.length > 0) {
    const expectedTotalVat = Math.trunc((totalPreTax * vatRate) / 100);
    const vatDiff = expectedTotalVat - totalVat;
    if (vatDiff !== 0) {
      lineResults[0].vatAmount += vatDiff;
      lineResults[0].amountAfterTax += vatDiff;
      totalVat += vatDiff;
      totalAfterTax += vatDiff;
    }
  }

  return { lines: lineResults, totalPreTax, totalVat, totalAfterTax };
}
