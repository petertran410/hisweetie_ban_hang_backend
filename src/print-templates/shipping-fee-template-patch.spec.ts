import { patchShippingFeeTemplate } from './shipping-fee-template-patch';

describe('patchShippingFeeTemplate', () => {
  it.each(['invoice', 'order'] as const)(
    'clones the discount row for a %s template',
    (templateFor) => {
      const content =
        '<table><tr style="height:10px"><td><strong>Giảm gi&aacute;:</strong></td><td>{Giam_Gia}</td></tr><tr><td>Tổng cộng</td></tr></table>';
      const result = patchShippingFeeTemplate(templateFor, content);

      expect(result).toContain('Phí ship:');
      expect(result).toContain('{Phi_Giao_Hang}');
      expect(result).toContain('{Style_Dong_Phi_Giao_Hang}height:10px');
      expect(result.match(/{Phi_Giao_Hang}/g)).toHaveLength(1);
      expect(result.indexOf('{Phi_Giao_Hang}')).toBeLessThan(
        result.indexOf('Tổng cộng'),
      );
    },
  );

  it('adds a conditional line to a consignment template', () => {
    const content =
      '<div>Giảm gi&aacute;: {Giam_Gia}</div><div>Tổng cộng: {Tong_Can_Thanh_Toan}</div>';
    const result = patchShippingFeeTemplate('consignment', content);

    expect(result).toContain(
      '<div style="{Style_Dong_Phi_Giao_Hang}">Phí ship: {Phi_Giao_Hang}</div>',
    );
    expect(result.indexOf('{Phi_Giao_Hang}')).toBeLessThan(
      result.indexOf('Tổng cộng'),
    );
  });

  it('is idempotent', () => {
    const content =
      '<div>Giảm giá: {Giam_Gia}</div><div>Phí ship: {Phi_Giao_Hang}</div>';

    expect(patchShippingFeeTemplate('consignment', content)).toBe(content);
  });

  it('fails instead of guessing when the discount anchor is missing', () => {
    expect(() => patchShippingFeeTemplate('order', '<p>Tổng cộng</p>')).toThrow(
      'Không tìm thấy dòng Giảm giá',
    );
  });
});
