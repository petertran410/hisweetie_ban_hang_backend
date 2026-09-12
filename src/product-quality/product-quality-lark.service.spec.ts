import { ProductQualityLarkService } from './product-quality-lark.service';
import { QUALITY_STATUS } from './product-quality.service';

describe('ProductQualityLarkService (Unit)', () => {
  let service: ProductQualityLarkService;
  let mockPrisma: any;
  let mockConfig: any;
  let mockUploadService: any;
  let mockAuditLogsService: any;

  beforeEach(() => {
    mockPrisma = {
      customer: {
        findMany: jest.fn().mockResolvedValue([
          { id: 10, code: 'KH001', name: 'Đại lý HiSweetie', larkRecordId: 'recCust1' },
        ]),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 20, code: 'SP000390', name: 'Trà Sữa Khoai Môn', unit: 'Gói', larkRecordId: 'recProd1' },
        ]),
      },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: 30, code: 'HD009999' },
        ]),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 40, name: 'Linh Thùy Dương', larkUserId: 'ou_user1' },
        ]),
      },
      branch: {
        findMany: jest.fn().mockResolvedValue([
          { id: 6, name: 'Kho Hà Nội' },
          { id: 1, name: 'Kho Sài Gòn' },
        ]),
      },
      productQualityTicket: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      productQualityTask: {
        upsert: jest.fn(),
      },
      productQualityAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
    };

    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'LARK_APP_ID') return 'app_test';
        if (key === 'LARK_APP_SECRET') return 'secret_test';
        return null;
      }),
    };

    mockUploadService = {
      saveFile: jest.fn().mockResolvedValue({
        filename: '1774424378-test.jpg',
        url: 'http://localhost:3060/uploads/product-quality/1774424378-test.jpg',
        size: 50000,
        mimetype: 'image/jpeg',
        originalname: 'test.jpg',
      }),
    };

    mockAuditLogsService = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    };

    service = new ProductQualityLarkService(
      mockPrisma,
      mockConfig,
      mockUploadService,
      mockAuditLogsService,
    );
  });

  describe('classifyAttachment', () => {
    it('classifies general proof images and videos', () => {
      const img = service.classifyAttachment('Hình Ảnh Minh Chứng', { file_token: 'tok1', name: 'error.png', type: 'image/png' });
      expect(img.kind).toBe('PROOF_IMAGE');
      expect(img.department).toBeUndefined();

      const vid = service.classifyAttachment('Video Minh Chứng', { file_token: 'tok2', name: 'clip.mp4', type: 'video/mp4' });
      expect(vid.kind).toBe('PROOF_VIDEO');
    });

    it('classifies department completion proof attachments correctly', () => {
      const kd = service.classifyAttachment('Phòng Kinh Doanh - Hình Ảnh Hoàn Thành', { file_token: 'tok3' });
      expect(kd.kind).toBe('COMPLETION_PROOF');
      expect(kd.department).toBe('Kinh Doanh');

      const kho = service.classifyAttachment('Kho + Logistics - Hình Ảnh Hoàn Thành', { file_token: 'tok4' });
      expect(kho.kind).toBe('COMPLETION_PROOF');
      expect(kho.department).toBe('Kho + Logistics');

      const kt = service.classifyAttachment('Kế Toán Kho - Hình Ảnh Hoàn Thành', { file_token: 'tok5' });
      expect(kt.kind).toBe('COMPLETION_PROOF');
      expect(kt.department).toBe('Kế Toán Kho');

      const tm = service.classifyAttachment('Thu Mua - Hình Ảnh Hoàn Thành', { file_token: 'tok6' });
      expect(tm.kind).toBe('COMPLETION_PROOF');
      expect(tm.department).toBe('Thu Mua');
    });
  });

  describe('sync records only (fast mode)', () => {
    it('upserts tickets without downloading media when downloadMedia is false', async () => {
      jest.spyOn(service, 'getTenantAccessToken').mockResolvedValue('test_token');
      jest.spyOn(service, 'fetchAllLarkRecords').mockResolvedValue([
        {
          record_id: 'rec_001',
          created_time: 1726056000000,
          fields: {
            'Mã Phiếu': 'CLSP-TEST-01',
            'Tên Khách Hàng': [{ id: 'recCust1', text: 'Đại lý HiSweetie' }],
            'Tên Sản Phẩm': [{ id: 'recProd1', text: 'Trà Sữa Khoai Môn' }],
            'Số Lượng': 4,
            'Kho': 'Kho Hà Nội',
            'Hình Ảnh Minh Chứng': [
              { file_token: 'file_tok_1', name: 'damaged.png', type: 'image/png', url: 'https://lark/download' },
            ],
          },
        },
      ]);

      mockPrisma.productQualityTicket.findFirst.mockResolvedValue(null);
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue(null);
      mockPrisma.productQualityTicket.create.mockResolvedValue({ id: 101, code: 'CLSP000001' });

      const downloadSpy = jest.spyOn(service, 'downloadLarkMediaBuffer');

      const res = await service.sync({ downloadMedia: false }, 1);

      expect(res.totalFetched).toBe(1);
      expect(res.importedCount).toBe(1);
      expect(mockPrisma.productQualityTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sourceRecordId: 'rec_001',
            customerId: 10,
            productId: 20,
            branchId: 6,
            quantity: 4,
          }),
        }),
      );

      // Fast mode MUST NOT download media
      expect(downloadSpy).not.toHaveBeenCalled();
      expect(mockUploadService.saveFile).not.toHaveBeenCalled();
    });
  });

  describe('sync with media downloading', () => {
    it('downloads media into uploads/product-quality/ and skips already downloaded tokens', async () => {
      jest.spyOn(service, 'getTenantAccessToken').mockResolvedValue('test_token');
      jest.spyOn(service, 'fetchAllLarkRecords').mockResolvedValue([
        {
          record_id: 'rec_002',
          created_time: 1726056000000,
          fields: {
            'Tên Khách Hàng': [{ text: 'Khách Test' }],
            'Tên Sản Phẩm': [{ text: 'SP Test' }],
            'Hình Ảnh Minh Chứng': [
              { file_token: 'tok_existing', name: 'old.png', url: 'https://lark/old' },
              { file_token: 'tok_new', name: 'new.jpg', type: 'image/jpeg', url: 'https://lark/new' },
            ],
          },
        },
      ]);

      const existingTicket = {
        id: 102,
        code: 'CLSP000002',
        sourceRecordId: 'rec_002',
        attachments: [{ larkFileToken: 'tok_existing' }],
      };
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue(existingTicket);
      mockPrisma.productQualityTicket.update.mockResolvedValue(existingTicket);

      jest.spyOn(service, 'downloadLarkMediaBuffer').mockResolvedValue(Buffer.from('fake_image_bytes'));

      const res = await service.sync({ downloadMedia: true }, 1);

      expect(res.mediaStats.totalDiscovered).toBe(2);
      expect(res.mediaStats.skippedExisting).toBe(1);
      expect(res.mediaStats.downloaded).toBe(1);

      expect(mockUploadService.saveFile).toHaveBeenCalledWith(
        expect.any(Buffer),
        'new.jpg',
        'image/jpeg',
        'product-quality',
      );

      expect(mockPrisma.productQualityAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: 102,
            larkFileToken: 'tok_new',
            kind: 'PROOF_IMAGE',
          }),
        }),
      );
    });
  });
});
