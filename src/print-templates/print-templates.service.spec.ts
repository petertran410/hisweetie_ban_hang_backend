import { PrintTemplatesService } from './print-templates.service';

describe('PrintTemplatesService', () => {
  const createService = (itemKeys: string[] = []) => {
    const prisma = {
      printTemplateVariable: {
        findMany: jest
          .fn()
          .mockResolvedValue(itemKeys.map((key) => ({ key }))),
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

      expect(content).toContain(
        '<td>Dễ vỡ<br />Để thẳng đứng</td>',
      );
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
});
