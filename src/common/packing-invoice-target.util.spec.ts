import { BadRequestException } from '@nestjs/common';
import { INVOICE_STATUS } from '../invoices/dto';
import {
  collapsePackingInvoiceTargets,
  pickLivePackingInvoice,
} from './packing-invoice-target.util';

const invoice = (id: number, code: string, status: number) => ({
  id,
  code,
  status,
});

describe('pickLivePackingInvoice', () => {
  const family = [
    invoice(1, 'HD128738', INVOICE_STATUS.CANCELLED),
    invoice(2, 'HD128738.01', INVOICE_STATUS.CANCELLED),
    invoice(3, 'HD128738.02', INVOICE_STATUS.PROCESSING),
    invoice(4, 'HD100000', INVOICE_STATUS.PROCESSING),
  ];

  it('giữ hóa đơn chưa hủy', () => {
    expect(pickLivePackingInvoice(family[3], family).id).toBe(4);
  });

  it('chuyển hóa đơn hủy sang hậu tố cao nhất còn hiệu lực', () => {
    expect(pickLivePackingInvoice(family[0], family).code).toBe('HD128738.02');
    expect(pickLivePackingInvoice(family[1], family).code).toBe('HD128738.02');
  });

  it('từ chối hóa đơn hủy không còn bản hiệu lực', () => {
    const onlyCancelled = [
      invoice(1, 'HD128738', INVOICE_STATUS.CANCELLED),
    ];
    expect(() => pickLivePackingInvoice(onlyCancelled[0], onlyCancelled)).toThrow(
      BadRequestException,
    );
  });
});

describe('collapsePackingInvoiceTargets', () => {
  it('gộp id cũ và id mới về một bản còn hiệu lực', () => {
    const family = [
      invoice(1, 'HD128738', INVOICE_STATUS.CANCELLED),
      invoice(2, 'HD128738.01', INVOICE_STATUS.DELIVERED),
    ];
    expect(collapsePackingInvoiceTargets([family[0], family[1]], family)).toEqual([
      2,
    ]);
  });
});
