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
 * Tính VAT cho 1 dòng hàng. Giá nhập (price) là giá ĐÃ GỒM thuế.
 *  - unitPriceAfterTax = price - discount                       (đơn giá sau thuế)
 *  - unitPrice         = round((price - discount)/(1+rate/100), 2)
 *  - amountAfterTax    = round(unitPriceAfterTax * quantity)    (neo vào gross)
 *  - amountBeforeTax   = round(amountAfterTax / (1 + rate/100))
 *  - vatAmount         = amountAfterTax - amountBeforeTax       (VAT = phần bù)
 *
 * Neo thành tiền sau thuế vào gross rồi bóc ngược tiền trước thuế + VAT đảm bảo
 * TRÊN TỪNG DÒNG: amountBeforeTax + vatAmount === amountAfterTax. Nhờ vậy tổng
 * sau thuế của cả hóa đơn luôn bằng tổng tiền hàng, không lệch do làm tròn.
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
  const amountAfterTax = Math.round(unitPriceAfterTax * quantity);
  const amountBeforeTax = Math.round(amountAfterTax / (1 + vatRate / 100));
  const vatAmount = amountAfterTax - amountBeforeTax;

  return {
    unitPriceAfterTax,
    unitPrice,
    amountBeforeTax,
    vatAmount,
    amountAfterTax,
  };
}

/**
 * Tính tổng VAT cho toàn hóa đơn bằng cách cộng dồn từng dòng. Vì mỗi dòng đã
 * đảm bảo amountBeforeTax + vatAmount === amountAfterTax (neo vào gross) nên
 * tổng sau thuế luôn khớp tổng tiền hàng — không cần fix-up chênh lệch. Bên gọi
 * nên lọc dòng có misa_code trước nếu muốn khớp tuyệt đối với voucher.
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

  return { lines: lineResults, totalPreTax, totalVat, totalAfterTax };
}

/**
 * Bóc VAT từ TỔNG hóa đơn đã gồm thuế (dùng cho trang hiển thị hóa đơn VAT).
 *
 * Khác với computeInvoiceVat (cộng dồn từng dòng — phục vụ đẩy voucher Misa),
 * hàm này tính trực tiếp từ grandTotal nên LUÔN đảm bảo:
 *    totalPreTax + totalVat === totalAfterTax === grandTotal
 * Không bị lệch vài đồng do làm tròn từng dòng, và không phụ thuộc việc sản
 * phẩm có map misa_code hay không.
 *
 *  - totalAfterTax = grandTotal (giá đã gồm VAT)
 *  - totalPreTax   = round(grandTotal / (1 + rate/100))
 *  - totalVat      = grandTotal - totalPreTax
 */
export function computeInvoiceVatFromTotal(
  grandTotal: VatNumeric | null | undefined,
  vatRate: number = MISA_VAT_RATE,
): { totalPreTax: number; totalVat: number; totalAfterTax: number } {
  const totalAfterTax = Math.round(Number(grandTotal || 0));
  const totalPreTax = Math.round(totalAfterTax / (1 + vatRate / 100));
  const totalVat = totalAfterTax - totalPreTax;

  return { totalPreTax, totalVat, totalAfterTax };
}
