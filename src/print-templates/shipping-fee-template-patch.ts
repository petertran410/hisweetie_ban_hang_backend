export const SHIPPING_FEE_VALUE_TOKEN = '{Phi_Giao_Hang}';
export const SHIPPING_FEE_STYLE_TOKEN = '{Style_Dong_Phi_Giao_Hang}';

export function patchShippingFeeTemplate(
  templateFor: 'invoice' | 'order' | 'consignment',
  content: string,
): string {
  if (
    content.includes(SHIPPING_FEE_VALUE_TOKEN) ||
    content.includes('{Dong_Phi_Giao_Hang}')
  ) {
    return content;
  }

  if (templateFor === 'consignment') {
    const discountLine =
      /<div[^>]*>[^<]*Giảm gi(?:á|&aacute;):\s*{Giam_Gia}<\/div>/i;
    const match = content.match(discountLine);
    if (!match) throw new Error('Không tìm thấy dòng Giảm giá của mẫu ký gửi');

    return content.replace(
      match[0],
      `${match[0]}\n<div style="${SHIPPING_FEE_STYLE_TOKEN}">Phí ship: ${SHIPPING_FEE_VALUE_TOKEN}</div>`,
    );
  }

  const discountRow = /<tr\b[^>]*>[\s\S]*?{Giam_Gia}[\s\S]*?<\/tr>/i;
  const match = content.match(discountRow);
  if (!match)
    throw new Error(`Không tìm thấy dòng Giảm giá của mẫu ${templateFor}`);

  let shippingRow = match[0]
    .replace(/Giảm gi(?:á|&aacute;):/i, 'Phí ship:')
    .replace(/{Giam_Gia}/g, SHIPPING_FEE_VALUE_TOKEN);

  if (/style="[^"]*"/i.test(shippingRow)) {
    shippingRow = shippingRow.replace(
      /style="([^"]*)"/i,
      `style="${SHIPPING_FEE_STYLE_TOKEN}$1"`,
    );
  } else {
    shippingRow = shippingRow.replace(
      /<tr\b/i,
      `<tr style="${SHIPPING_FEE_STYLE_TOKEN}"`,
    );
  }

  return content.replace(match[0], `${match[0]}\n${shippingRow}`);
}
