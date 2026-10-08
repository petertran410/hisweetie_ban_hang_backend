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
});
