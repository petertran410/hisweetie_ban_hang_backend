import { of, throwError } from 'rxjs';
import { MisaVoucherService } from './misa-voucher.service';

describe('MisaVoucherService OpenAPI flow', () => {
  const makeConfig = () => ({
    get: jest.fn((key: string) => {
      const values: Record<string, string> = {
        MISA_BASE_URL: 'https://developer.misa.vn/apis',
        MISA_CLIENT_ID: 'client-id',
        MISA_ORG_COMPANY_CODE: 'company-code',
        MISA_BRANCH_ID: 'misa-branch-id',
      };
      return values[key];
    }),
  });

  it('resolves POS branches to active Misa stocks by stockCode', async () => {
    const findFirst = jest.fn().mockImplementation(async ({ where }: any) => ({
      stockId: `${where.stockCode}-id`,
      stockCode: where.stockCode,
      stockName: `${where.stockCode} name`,
    }));
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      { misaStock: { findFirst } } as any,
      {} as any,
      {} as any,
    );

    await expect((service as any).resolveMisaStock(6)).resolves.toEqual({
      stockId: 'KHO1-id',
      stockCode: 'KHO1',
      stockName: 'KHO1 name',
    });
    await expect((service as any).resolveMisaStock(1)).resolves.toEqual({
      stockId: 'KHOHCM-id',
      stockCode: 'KHOHCM',
      stockName: 'KHOHCM name',
    });
    await expect((service as any).resolveMisaStock(99)).rejects.toThrow(
      'Chưa cấu hình kho Misa',
    );
  });

  it('sends the voucher through the new save endpoint without app_id', async () => {
    const post = jest.fn().mockReturnValue(
      of({
        data: {
          Success: true,
          Data: 'queued',
        },
      }),
    );
    const service = new MisaVoucherService(
      makeConfig() as any,
      { post } as any,
      {} as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
      {} as any,
    );
    const payload = {
      org_company_code: 'company-code',
      voucher: [
        {
          org_refid: 'org-refid',
          org_refno: 'INV-001',
        },
      ],
    };

    await expect((service as any).sendVoucherToMisa(payload)).resolves.toEqual({
      success: true,
      message: 'queued',
    });

    expect(post).toHaveBeenCalledWith(
      'https://developer.misa.vn/apis/amiskt/v1/save',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          ClientID: 'client-id',
          'X-MISA-AccessToken': 'access-token',
        },
        timeout: 20000,
      },
    );
    expect(post.mock.calls[0][1]).not.toHaveProperty('app_id');
  });

  it('logs a safe rejection diagnostic without the access token or payload', async () => {
    const post = jest.fn().mockReturnValue(
      of({
        status: 400,
        data: {
          Success: false,
          ErrorCode: 'InvalidParam',
          ErrorMessage: 'Invalid voucher',
          Data: 'details',
        },
      }),
    );
    const service = new MisaVoucherService(
      makeConfig() as any,
      { post } as any,
      {} as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
      {} as any,
    );
    const errorLog = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    const result = await (service as any).sendVoucherToMisa({
      org_company_code: 'company-code',
      voucher: [{ org_refid: 'org-refid', org_refno: 'INV-001' }],
    });

    expect(result).toMatchObject({
      success: false,
      stage: 'misa_rejected',
      message: 'InvalidParam: Invalid voucher',
    });
    // Lỗi dữ liệu do MISA từ chối → không thử lại.
    expect(post).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('[stage=misa_rejected]'),
    );
    const logged = errorLog.mock.calls.flat().join(' ');
    expect(logged).toContain('InvalidParam');
    expect(logged).not.toContain('access-token');
    expect(logged).not.toContain('"voucher"');
  });

  it('logs HTTP status and truncated response information for request failures', async () => {
    const post = jest.fn().mockReturnValue(
      throwError(() => ({
        message: 'Request failed with status code 503',
        response: {
          status: 503,
          data: { message: 'Service unavailable' },
        },
      })),
    );
    const service = new MisaVoucherService(
      makeConfig() as any,
      { post } as any,
      {} as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
      {} as any,
    );
    const errorLog = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    const result = await (service as any).sendVoucherToMisa({
      org_company_code: 'company-code',
      voucher: [{ org_refid: 'org-refid', org_refno: 'INV-001' }],
    });

    expect(result).toMatchObject({
      success: false,
      stage: 'misa_request',
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('httpStatus=503'),
    );
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('[stage=misa_request]'),
    );
    // 503 là lỗi tạm thời → 1 lần gọi + 2 lần thử lại.
    expect(post).toHaveBeenCalledTimes(3);
  });

  describe('save retry on transient errors', () => {
    const payload = {
      org_company_code: 'company-code',
      voucher: [{ org_refid: 'org-refid', org_refno: 'INV-001' }],
    };

    const makeService = (post: jest.Mock, config = makeConfig()) => {
      const service = new MisaVoucherService(
        config as any,
        { post } as any,
        {} as any,
        { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
        {} as any,
      );
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => {});
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const sleep = jest
        .spyOn(service as any, 'sleep')
        .mockResolvedValue(undefined);
      return { service, sleep };
    };

    it('retries a 503 and succeeds on the next attempt', async () => {
      const post = jest
        .fn()
        .mockReturnValueOnce(
          throwError(() => ({
            message: 'Request failed with status code 503',
            response: { status: 503, data: {} },
          })),
        )
        .mockReturnValueOnce(of({ data: { Success: true, Data: 'queued' } }));
      const { service, sleep } = makeService(post);

      await expect(
        (service as any).sendVoucherToMisa(payload),
      ).resolves.toEqual({ success: true, message: 'queued' });
      expect(post).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1000);
    });

    it('gives up after repeated timeouts with stage misa_request', async () => {
      const post = jest.fn().mockReturnValue(
        throwError(() => ({
          message: 'timeout of 20000ms exceeded',
          code: 'ECONNABORTED',
        })),
      );
      const { service, sleep } = makeService(post);

      const result = await (service as any).sendVoucherToMisa(payload);

      expect(result).toMatchObject({ success: false, stage: 'misa_request' });
      expect(post).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[1000], [3000]]);
    });

    it('does not retry a 400 response', async () => {
      const post = jest.fn().mockReturnValue(
        throwError(() => ({
          message: 'Request failed with status code 400',
          response: { status: 400, data: {} },
        })),
      );
      const { service, sleep } = makeService(post);

      await (service as any).sendVoucherToMisa(payload);

      expect(post).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('bulk pacing', () => {
    const queued = {
      success: true,
      orgRefId: 'org-refid',
      message: 'queued',
    };

    const makeService = (bulkDelay?: string) => {
      const config = {
        get: jest.fn((key: string) =>
          key === 'MISA_BULK_DELAY_MS' ? bulkDelay : undefined,
        ),
      };
      const service = new MisaVoucherService(
        config as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      jest.spyOn((service as any).logger, 'log').mockImplementation(() => {});
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});
      const sleep = jest
        .spyOn(service as any, 'sleep')
        .mockResolvedValue(undefined);
      return { service, sleep };
    };

    it('pauses between invoices that reached Misa, not after the last one', async () => {
      const { service, sleep } = makeService();
      jest
        .spyOn(service, 'createSaleVoucherFromInvoice')
        .mockResolvedValue(queued);

      await service.createVouchersBulk(['INV-001', 'INV-002', 'INV-003']);

      expect(sleep.mock.calls).toEqual([[500], [500]]);
    });

    it('skips the pause for invoices stopped before calling Misa', async () => {
      const { service, sleep } = makeService();
      jest
        .spyOn(service, 'createSaleVoucherFromInvoice')
        .mockResolvedValueOnce({
          success: false,
          orgRefId: null,
          message: 'Missing Misa code',
          stage: 'missing_misa_code',
        })
        .mockResolvedValueOnce(queued);

      await service.createVouchersBulk(['INV-001', 'INV-002']);

      expect(sleep).not.toHaveBeenCalled();
    });

    it('uses MISA_BULK_DELAY_MS and allows turning the pause off', async () => {
      const custom = makeService('1500');
      jest
        .spyOn(custom.service, 'createSaleVoucherFromInvoice')
        .mockResolvedValue(queued);
      await custom.service.createVouchersBulk(['INV-001', 'INV-002']);
      expect(custom.sleep.mock.calls).toEqual([[1500]]);

      const off = makeService('0');
      jest
        .spyOn(off.service, 'createSaleVoucherFromInvoice')
        .mockResolvedValue(queued);
      await off.service.createVouchersBulk(['INV-001', 'INV-002']);
      expect(off.sleep).not.toHaveBeenCalled();
    });
  });

  it('logs a grouped summary for bulk failures by stage', async () => {
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest
      .spyOn(service, 'createSaleVoucherFromInvoice')
      .mockResolvedValueOnce({
        success: false,
        orgRefId: null,
        message: 'Missing Misa code',
        stage: 'missing_misa_code',
      })
      .mockResolvedValueOnce({
        success: false,
        orgRefId: null,
        message: 'Misa rejected',
        stage: 'misa_rejected',
      })
      .mockResolvedValueOnce({
        success: true,
        orgRefId: 'org-refid',
        message: 'queued',
      });
    const warnLog = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);

    await service.createVouchersBulk(['INV-001', 'INV-002', 'INV-003']);

    expect(warnLog).toHaveBeenCalledWith(
      '📊 Misa bulk failure summary: missing_misa_code=1, misa_rejected=1',
    );
  });

  it('marks the invoice PENDING when Misa accepts the new save request', async () => {
    const invoice = {
      id: 10,
      code: 'INV-001',
      status: 1,
      misaSyncStatus: 'SKIP',
      misaOrgRefId: null,
      branchId: 6,
      purchaseDate: new Date('2026-10-06T00:00:00.000Z'),
      customerName: 'Khách lẻ',
      customer: null,
      details: [
        {
          quantity: 1,
          price: 108,
          discount: 0,
          productCode: 'P-001',
          product: {
            id: 1,
            code: 'P-001',
            name: 'Sản phẩm test',
            misa_code: 'M-001',
            misa_name: 'Sản phẩm Misa',
            misa_unit: 'Cái',
          },
        },
      ],
    };
    const invoiceFindUnique = jest
      .fn()
      .mockResolvedValueOnce(invoice)
      .mockResolvedValueOnce({ id: invoice.id });
    const invoiceUpdate = jest.fn().mockResolvedValue({});
    const savePost = jest.fn().mockReturnValue(
      of({
        data: {
          Success: true,
          Data: 'queued',
        },
      }),
    );
    const prisma = {
      invoice: {
        findUnique: invoiceFindUnique,
        update: invoiceUpdate,
      },
      misaStock: {
        findFirst: jest.fn().mockResolvedValue({
          stockId: 'stock-kho1',
          stockCode: 'KHO1',
          stockName: 'Kho 1',
        }),
      },
      misaAccountObject: {
        findFirst: jest.fn(),
      },
    };
    const service = new MisaVoucherService(
      makeConfig() as any,
      { post: savePost } as any,
      prisma as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
      {
        findInventoryItemByCode: jest.fn().mockResolvedValue({
          inventoryItemId: 'item-1',
          inventoryItemCode: 'M-001',
          inventoryItemName: 'Sản phẩm Misa',
          unitId: 'unit-1',
          unitName: 'Cái',
        }),
        findAccountObjectByNameFuzzy: jest.fn().mockResolvedValue(null),
      } as any,
    );

    await expect(
      service.createSaleVoucherFromInvoice(invoice.code),
    ).resolves.toMatchObject({
      success: true,
      message: 'queued',
    });

    expect(savePost.mock.calls[0][1].voucher[0].detail[0]).toMatchObject({
      stock_id: 'stock-kho1',
      stock_code: 'KHO1',
      stock_name: 'Kho 1',
    });
    expect(savePost.mock.calls[0][1].voucher[0]).toMatchObject({
      voucher_type: 13,
      reftype: 3530,
      is_sale_with_outward: true,
    });
    expect(savePost.mock.calls[0][1].voucher[0]).toHaveProperty('sa_invoice');
    expect(savePost.mock.calls[0][1].voucher[0]).toHaveProperty('in_outward');
    expect(invoiceUpdate).toHaveBeenCalledWith({
      where: { id: invoice.id },
      data: expect.objectContaining({
        misaSyncStatus: 'PENDING',
        misaOrgRefId: expect.any(String),
        misaConfirmed: false,
        misaCallbackReceivedAt: null,
        misaErrorMessage: null,
      }),
    });
  });

  it('moves a pending invoice to SYNCED after a successful callback', async () => {
    const invoice = {
      id: 10,
      code: 'INV-001',
      misaSyncStatus: 'PENDING',
      misaConfirmed: false,
      misaErrorMessage: null,
    };
    const findUnique = jest.fn().mockResolvedValue(invoice);
    const update = jest.fn().mockResolvedValue({});
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      { invoice: { findUnique, update } } as any,
      {} as any,
      {} as any,
    );

    await service.handleMisaCallback(
      'org-refid',
      'success',
      'voucher-id',
      'voucher-no',
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: invoice.id },
      data: expect.objectContaining({
        misaSyncStatus: 'SYNCED',
        misaConfirmed: true,
        misaErrorMessage: null,
        misaCallbackReceivedAt: expect.any(Date),
      }),
    });
  });

  it('moves a pending invoice to FAILED after a failed callback', async () => {
    const invoice = {
      id: 10,
      code: 'INV-001',
      misaSyncStatus: 'PENDING',
      misaConfirmed: false,
      misaErrorMessage: null,
    };
    const update = jest.fn().mockResolvedValue({});
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      {
        invoice: {
          findUnique: jest.fn().mockResolvedValue(invoice),
          update,
        },
      } as any,
      {} as any,
      {} as any,
    );

    await service.handleMisaCallback(
      'org-refid',
      'failed',
      undefined,
      undefined,
      'InvalidParam',
      'Voucher không hợp lệ',
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: invoice.id },
      data: expect.objectContaining({
        misaSyncStatus: 'FAILED',
        misaConfirmed: false,
        misaErrorMessage: 'InvalidParam: Voucher không hợp lệ',
        misaCallbackReceivedAt: expect.any(Date),
      }),
    });
  });

  it('ignores a duplicate successful callback for an already confirmed invoice', async () => {
    const invoice = {
      id: 10,
      code: 'INV-001',
      misaSyncStatus: 'SYNCED',
      misaConfirmed: true,
    };
    const update = jest.fn().mockResolvedValue({});
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      {
        invoice: {
          findUnique: jest.fn().mockResolvedValue(invoice),
          update,
        },
      } as any,
      {} as any,
      {} as any,
    );

    await service.handleMisaCallback('org-refid', 'success');

    expect(update).not.toHaveBeenCalled();
  });

  it('ignores callbacks for an unknown orgRefId without updating invoices', async () => {
    const update = jest.fn().mockResolvedValue({});
    const service = new MisaVoucherService(
      makeConfig() as any,
      {} as any,
      {
        invoice: {
          findUnique: jest.fn().mockResolvedValue(null),
          update,
        },
      } as any,
      {} as any,
      {} as any,
    );

    await service.handleMisaCallback('unknown-org-refid', 'success');

    expect(update).not.toHaveBeenCalled();
  });

  it('uses the new delete endpoint and voucher_type 13', async () => {
    const deleteRequest = jest.fn().mockReturnValue(
      of({
        status: 200,
        data: {
          Success: true,
          ErrorMessage: '',
        },
      }),
    );
    const service = new MisaVoucherService(
      makeConfig() as any,
      { delete: deleteRequest } as any,
      {} as any,
      { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
      {} as any,
    );

    await expect(
      (service as any).sendDeleteVoucherToMisa('org-refid'),
    ).resolves.toEqual({
      success: true,
      message: 'Voucher deleted successfully',
    });

    expect(deleteRequest).toHaveBeenCalledWith(
      'https://developer.misa.vn/apis/amiskt/v1/delete',
      {
        headers: {
          'Content-Type': 'application/json',
          ClientID: 'client-id',
          'X-MISA-AccessToken': 'access-token',
        },
        data: {
          org_company_code: 'company-code',
          voucher: [{ voucher_type: 13, org_refid: 'org-refid' }],
        },
      },
    );
  });

  describe('per-line VAT rate (GTGT dòng SP007601)', () => {
    const line = (
      code: string,
      price: number,
      lineVatRate: number | null,
      quantity = 1,
    ) => ({
      quantity,
      price,
      discount: 0,
      lineVatRate,
      productCode: code,
      product: {
        id: code.length,
        code,
        name: `Sản phẩm ${code}`,
        misa_code: `M-${code}`,
        misa_name: `Misa ${code}`,
        misa_unit: 'Cái',
      },
    });

    // Dựng payload thật qua createSaleVoucherFromInvoice, chặn ở httpService.post.
    const pushVoucher = async (details: any[]) => {
      const invoice = {
        id: 20,
        code: 'INV-VAT',
        status: 1,
        misaSyncStatus: 'SKIP',
        misaOrgRefId: null,
        branchId: 6,
        purchaseDate: new Date('2026-11-28T00:00:00.000Z'),
        customerName: 'Khách lẻ',
        customer: null,
        details,
      };
      const savePost = jest
        .fn()
        .mockReturnValue(of({ data: { Success: true, Data: 'queued' } }));
      const prisma = {
        invoice: {
          findUnique: jest.fn().mockResolvedValue(invoice),
          update: jest.fn().mockResolvedValue({}),
        },
        misaStock: {
          findFirst: jest.fn().mockResolvedValue({
            stockId: 'stock-kho1',
            stockCode: 'KHO1',
            stockName: 'Kho 1',
          }),
        },
        misaAccountObject: { findFirst: jest.fn() },
      };
      const service = new MisaVoucherService(
        makeConfig() as any,
        { post: savePost } as any,
        prisma as any,
        { getAccessToken: jest.fn().mockResolvedValue('access-token') } as any,
        {
          findInventoryItemByCode: jest.fn(async (code: string) => ({
            inventoryItemId: `${code}-id`,
            inventoryItemCode: code,
            inventoryItemName: `Misa ${code}`,
            unitId: 'unit-1',
            unitName: 'Cái',
          })),
          findAccountObjectByNameFuzzy: jest.fn().mockResolvedValue(null),
        } as any,
      );

      await expect(
        service.createSaleVoucherFromInvoice(invoice.code),
      ).resolves.toMatchObject({ success: true });
      return savePost.mock.calls[0][1].voucher[0];
    };

    it('sends SP007601 as 5% or KKKNT (-2) and everything else as 8%', async () => {
      const voucher = await pushVoucher([
        line('P-001', 108, 0), // SP khác, lineVatRate 0 do mặc định DB → 8%
        line('SP007601', 105, 5), // chọn 5%
        line('SP007601', 100, 0), // chọn "0%" = KKKNT, không phải thuế suất 0%
        line('SP007601', 108, null), // dòng HĐ cũ chưa chọn → 8% như trước
        line('P-002', 108, 0),
      ]);

      expect(voucher.detail.map((d: any) => d.vat_rate)).toEqual([
        8, 5, -2, 8, 8,
      ]);
      expect(voucher.detail.map((d: any) => d.vat_amount)).toEqual([
        8, 5, 0, 8, 8,
      ]);
      expect(voucher.detail.map((d: any) => d.amount)).toEqual([
        100, 100, 100, 100, 100,
      ]);
      expect(voucher.detail[2]).toMatchObject({
        unit_price: 100,
        amount_oc: 100,
        vat_amount_oc: 0,
      });

      for (const target of [voucher, voucher.sa_invoice]) {
        expect(target).toMatchObject({
          total_sale_amount: 500,
          total_vat_amount: 29,
          total_amount: 529, // = 108 + 105 + 100 + 108 + 108
        });
      }
      expect(voucher.sa_invoice.detail.map((d: any) => d.vat_rate)).toEqual([
        8, 5, -2, 8, 8,
      ]);
      expect(voucher.sa_invoice.detail[2].amount_after_tax).toBe(100);

      // KKKNT không bao giờ được gửi thành thuế suất 0%.
      const allRates = [...voucher.detail, ...voucher.sa_invoice.detail].map(
        (d: any) => d.vat_rate,
      );
      expect(allRates).not.toContain(0);
    });

    it('keeps the 8%-only rounding fix-up exactly as before', async () => {
      // 3 dòng 10đ: mỗi dòng 9 + 1 VAT; trunc(27 × 8%) = 2 → bù -1 vào dòng đầu.
      const voucher = await pushVoucher([
        line('P-001', 10, 0),
        line('P-002', 10, 0),
        line('P-003', 10, 0),
      ]);

      expect(voucher.detail.map((d: any) => d.vat_amount)).toEqual([0, 1, 1]);
      expect(voucher.detail.map((d: any) => d.amount)).toEqual([10, 9, 9]);
      expect(voucher).toMatchObject({
        total_sale_amount: 28,
        total_vat_amount: 2,
        total_amount: 30,
      });
    });

    it('applies the rounding fix-up per rate group and never to a KKKNT line', async () => {
      const voucher = await pushVoucher([
        line('SP007601', 50, 0), // KKKNT đứng đầu
        line('P-001', 10, 0),
        line('P-002', 10, 0),
        line('P-003', 10, 0),
      ]);

      expect(voucher.detail.map((d: any) => d.vat_rate)).toEqual([-2, 8, 8, 8]);
      // Bù -1 vào dòng 8% đầu tiên (dòng 2), dòng KKKNT giữ VAT 0.
      expect(voucher.detail.map((d: any) => d.vat_amount)).toEqual([
        0, 0, 1, 1,
      ]);
      expect(voucher.detail.map((d: any) => d.amount)).toEqual([50, 10, 9, 9]);
      expect(voucher).toMatchObject({
        total_sale_amount: 78,
        total_vat_amount: 2,
        total_amount: 80,
      });
    });
  });
});
