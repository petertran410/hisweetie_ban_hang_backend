import { MisaSyncController } from './misa-sync.controller';

describe('MisaSyncController callback adapter', () => {
  const makeController = () => {
    const voucherService = {
      handleMisaCallback: jest.fn().mockResolvedValue(undefined),
    };

    return {
      controller: new MisaSyncController(
        voucherService as any,
        {} as any,
        {} as any,
      ),
      voucherService,
    };
  };

  it('parses the OpenAPI callback data JSON string and maps success=true', async () => {
    const { controller, voucherService } = makeController();

    await expect(
      controller.handleCallback({
        success: true,
        app_id: 'app-id',
        error_message: '',
        signature: 'signature',
        data_type: 1,
        org_company_code: 'company-code',
        data: JSON.stringify([
          {
            org_refid: 'org-refid',
            success: true,
            session_id: 'session-id',
            voucher_type: 13,
          },
        ]),
      }),
    ).resolves.toEqual({
      success: true,
      message: 'Processed 1 callback(s)',
    });

    expect(voucherService.handleMisaCallback).toHaveBeenCalledWith(
      'org-refid',
      'success',
      undefined,
      undefined,
      undefined,
      '',
    );
  });

  it('maps success=false and item errors to the failed callback state', async () => {
    const { controller, voucherService } = makeController();

    await controller.handleCallback({
      success: true,
      data: JSON.stringify([
        {
          org_refid: 'org-refid',
          success: false,
          error_message: 'Invalid voucher',
        },
      ]),
    });

    expect(voucherService.handleMisaCallback).toHaveBeenCalledWith(
      'org-refid',
      'failed',
      undefined,
      undefined,
      undefined,
      'Invalid voucher',
    );
  });

  it('returns an invalid format response for malformed callback data', async () => {
    const { controller, voucherService } = makeController();

    await expect(
      controller.handleCallback({
        success: true,
        data: '{invalid-json',
      }),
    ).resolves.toEqual({
      success: false,
      message: 'Invalid data format',
    });

    expect(voucherService.handleMisaCallback).not.toHaveBeenCalled();
  });
});
