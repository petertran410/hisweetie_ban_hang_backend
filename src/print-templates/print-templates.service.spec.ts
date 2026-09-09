import { PrintTemplatesService } from './print-templates.service';

describe('PrintTemplatesService', () => {
  const previousSecret = process.env.DOCUMENT_QR_SECRET;

  beforeAll(() => {
    process.env.DOCUMENT_QR_SECRET = 'test-document-qr-secret';
  });

  afterAll(() => {
    if (previousSecret === undefined) {
      delete process.env.DOCUMENT_QR_SECRET;
    } else {
      process.env.DOCUMENT_QR_SECRET = previousSecret;
    }
  });

  const createService = (itemKeys: string[] = []) => {
    const prisma = {
      printTemplateVariable: {
        findMany: jest.fn().mockResolvedValue(itemKeys.map((key) => ({ key }))),
      },
    };

    return new PrintTemplatesService(prisma as any);
  };

  describe('replaceVariables', () => {
    it('preserves line breaks in document notes', async () => {
      const service = createService();

      const content = await service.replaceVariables(
        '<div>{Ghi_Chu}</div>',
        { Ghi_Chu: 'Dòng 1\nDòng 2\r\nDòng 3\rDòng 4' },
        'order',
      );

      expect(content).toBe(
        '<div>Dòng 1<br />Dòng 2<br />Dòng 3<br />Dòng 4</div>',
      );
    });

    it('preserves line breaks in item notes', async () => {
      const service = createService(['Ghi_Chu_Hang_Hoa', 'Ten_Hang_Hoa']);

      const content = await service.replaceVariables(
        '<table><tr><td>{Ten_Hang_Hoa}</td><td>{Ghi_Chu_Hang_Hoa}</td></tr></table>',
        {
          items: [
            {
              Ten_Hang_Hoa: 'Sản phẩm A',
              Ghi_Chu_Hang_Hoa: 'Dễ vỡ\nĐể thẳng đứng',
            },
          ],
        },
        'order',
      );

      expect(content).toContain('<td>Dễ vỡ<br />Để thẳng đứng</td>');
    });

    it('escapes HTML in notes but keeps intentional HTML variables', async () => {
      const service = createService();

      const content = await service.replaceVariables(
        '<div>{Ghi_Chu}</div><div>{Ma_QR_Code}</div>',
        {
          Ghi_Chu: '<script>alert("x")</script>\nAn toàn & rõ ràng',
          Ma_QR_Code: '<img src="qr.png" />',
        },
        'order',
      );

      expect(content).toBe(
        '<div>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br />An toàn &amp; rõ ràng</div><div><img src="qr.png" /></div>',
      );
    });
  });

  describe('mapItem', () => {
    const mapItem = (item: Record<string, any>) =>
      (createService() as any).mapItem({
        productName: 'Trà đào',
        quantity: 1,
        ...item,
      });

    it('appends the damaged condition to the product name', () => {
      expect(mapItem({ conditionType: 'damaged' }).Ten_Hang_Hoa).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Bục rách)</span>',
      );
    });

    it('appends the near-expiry month in MM/YYYY format', () => {
      expect(
        mapItem({
          conditionType: 'near_expiry',
          soldExpiryDate: '2026-08-01T00:00:00.000Z',
        }).Ten_Hang_Hoa,
      ).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Cận date 08/2026)</span>',
      );
    });

    it('keeps the near-expiry label when the expiry date is missing', () => {
      expect(mapItem({ conditionType: 'near_expiry' }).Ten_Hang_Hoa).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Cận date)</span>',
      );
    });

    it('does not append a condition to normal products', () => {
      expect(mapItem({ conditionType: 'normal' }).Ten_Hang_Hoa).toBe('Trà đào');
    });

    it('preserves both condition and promotion labels', () => {
      expect(
        mapItem({
          conditionType: 'near_expiry',
          soldExpiryDate: '2027-01-15',
          promotionId: 1,
          lineType: 'normal',
        }).Ten_Hang_Hoa,
      ).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Cận date 01/2027)</span> <span style="font-size:7pt;font-weight:bold;font-style:italic">(KM)</span>',
      );
    });

    it('styles gift and discounted-buy promotion labels', () => {
      expect(mapItem({ lineType: 'gift', isGift: true }).Ten_Hang_Hoa).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Quà KM)</span>',
      );
      expect(mapItem({ lineType: 'discounted_buy' }).Ten_Hang_Hoa).toBe(
        'Trà đào <span style="font-size:7pt;font-weight:bold;font-style:italic">(Mua kèm KM)</span>',
      );
    });
  });

  describe('mapInternalUse', () => {
    const mapInternalUse = (detail: Record<string, any>) =>
      (createService() as any).mapInternalUse({
        totalValue: 0,
        details: [{ productName: 'Trà đào', quantity: 1, ...detail }],
      }).items[0].Ten_Hang_Hoa;

    it('appends damaged and near-expiry information to internal-use items', () => {
      expect(mapInternalUse({ conditionType: 'damaged' })).toContain(
        '(Bục rách)',
      );
      expect(
        mapInternalUse({
          conditionType: 'near_expiry',
          soldExpiryDate: '2026-08-01T00:00:00.000Z',
        }),
      ).toContain('(Cận date 08/2026)');
      expect(
        mapInternalUse({
          conditionType: 'near_expiry',
          soldExpiryDate: null,
        }),
      ).toContain('(Cận date - Chưa xác định NSX)');
    });
  });

  describe('shipping fee print variables', () => {
    const baseEntity = {
      code: '',
      branch: null,
      customer: null,
      soldBy: null,
      creator: null,
      delivery: null,
      totalAmount: 0,
      discount: 0,
      grandTotal: 0,
      paidAmount: 0,
      debtAmount: 0,
      items: [],
      details: [],
    };

    it.each([
      ['invoice', 'mapInvoice'],
      ['order', 'mapOrder'],
      ['consignment', 'mapConsignment'],
    ])('hides the conditional row for a zero-fee %s', async (_type, mapper) => {
      const data = await (createService() as any)[mapper]({
        ...baseEntity,
        shippingFee: null,
      });

      expect(data.Phi_Giao_Hang).toBe('0');
      expect(data.Dong_Phi_Giao_Hang).toBe('');
      expect(data.Style_Dong_Phi_Giao_Hang).toBe('display:none;');
    });

    it.each([
      ['invoice', 'mapInvoice'],
      ['order', 'mapOrder'],
      ['consignment', 'mapConsignment'],
    ])(
      'shows a formatted conditional row for a positive-fee %s',
      async (_type, mapper) => {
        const data = await (createService() as any)[mapper]({
          ...baseEntity,
          shippingFee: 25000,
        });

        expect(data.Phi_Giao_Hang).toBe('25,000');
        expect(data.Dong_Phi_Giao_Hang).toBe(
          '<div>Phí giao hàng: 25,000</div>',
        );
        expect(data.Style_Dong_Phi_Giao_Hang).toBe('');
      },
    );
  });
});
