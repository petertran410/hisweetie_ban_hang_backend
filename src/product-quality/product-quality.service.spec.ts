import { ProductQualityService, QUALITY_STATUS } from './product-quality.service';

describe('ProductQualityService (Unit)', () => {
  let service: ProductQualityService;
  let mockPrisma: any;
  let mockNotifications: any;
  let mockAuditLogs: any;
  let mockConfig: any;
  let mockImportService: any;
  let mockLarkService: any;

  beforeEach(() => {
    mockPrisma = {
      productQualityTicket: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        upsert: jest.fn(),
      },
      productQualityTask: {
        findMany: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn(),
        count: jest.fn(),
      },
      productQualityAttachment: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      productQualityTicketInvoice: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(),
      },
      productQualityRoutingConfig: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
      },
      productQualityDepartmentMember: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
        delete: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      branch: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      customer: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      product: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      invoice: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((cb) => cb(mockPrisma)),
    };

    mockNotifications = {
      createForUsers: jest.fn().mockResolvedValue(1),
    };

    mockAuditLogs = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    };

    mockImportService = {
      getTemplate: jest.fn(),
      preview: jest.fn(),
      commit: jest.fn(),
    };

    mockLarkService = {
      sync: jest.fn(),
    };

    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'LARK_APP_ID') return 'app_test';
        if (key === 'LARK_APP_SECRET') return 'secret_test';
        return null;
      }),
    };

    service = new ProductQualityService(
      mockPrisma,
      mockConfig,
      mockNotifications,
      mockAuditLogs,
      mockImportService,
      mockLarkService,
    );
  });

  describe('generateCode', () => {
    it('starts with CLSP000001 when no existing ticket', async () => {
      mockPrisma.productQualityTicket.findFirst.mockResolvedValue(null);
      const code = await service.generateCode();
      expect(code).toBe('CLSP000001');
    });

    it('increments from last code', async () => {
      mockPrisma.productQualityTicket.findFirst.mockResolvedValue({ code: 'CLSP000042' });
      const code = await service.generateCode();
      expect(code).toBe('CLSP000043');
    });
  });

  describe('create ticket and routing', () => {
    it('assigns decision maker directly from input and notifies', async () => {
      mockPrisma.productQualityTicket.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockImplementation(({ where }: any) => {
        if (where.id === 10) return Promise.resolve({ id: 10, name: 'Linh Thùy Dương' });
        return Promise.resolve({ id: 1, name: 'Nguyễn Văn A' });
      });
      mockPrisma.productQualityTicket.create.mockImplementation(({ data }: any) => ({
        id: 100,
        ...data,
      }));

      // findOne call at the end
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 100,
        code: 'CLSP000001',
        customerName: 'Khách Test',
        productName: 'Sản phẩm Test',
        decisionMakerId: 10,
        decisionMakerName: 'Linh Thùy Dương',
        status: QUALITY_STATUS.NEW,
      });

      const result = await service.create(
        {
          customerName: 'Khách Test',
          productName: 'Sản phẩm Test',
          quantity: 5,
          initialClassification: 'Chất Lượng Sản Phẩm',
          feedbackType: 'Hàng Lỗi / Hỏng',
          decisionMakerId: 10,
        },
        1,
        6,
      );

      expect(result.decisionMakerId).toBe(10);
      expect(mockNotifications.createForUsers).toHaveBeenCalled();
    });

    it('derives sourceType from product middleName and links related invoices', async () => {
      mockPrisma.productQualityTicket.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'Nguyễn Văn A' });
      mockPrisma.product.findUnique.mockResolvedValue({
        code: 'SP1',
        name: 'Sản phẩm 1',
        unit: 'Thùng',
        middleName: 'Nhập khẩu Trung Quốc',
      });
      mockPrisma.invoice.findMany.mockResolvedValue([
        { id: 11, code: 'HD0001' },
        { id: 12, code: 'HD0002' },
      ]);
      mockPrisma.productQualityTicket.create.mockImplementation(({ data }: any) => ({
        id: 101,
        ...data,
      }));
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 101,
        code: 'CLSP000002',
        customerName: 'Khách Test',
        productName: 'Sản phẩm 1',
        status: QUALITY_STATUS.NEW,
      });

      await service.create(
        {
          customerName: 'Khách Test',
          productId: 7,
          productName: 'Sản phẩm 1',
          quantity: 2,
          initialClassification: 'Chất Lượng Sản Phẩm',
          feedbackType: 'Hàng Lỗi / Hỏng',
          decisionMakerId: 1,
          invoiceIds: [11, 12],
        },
        1,
        6,
      );

      const createdData = mockPrisma.productQualityTicket.create.mock.calls[0][0].data;
      expect(createdData.sourceType).toBe('Nhập khẩu Trung Quốc');
      expect(createdData.invoiceId).toBe(11);
      expect(createdData.invoiceCode).toBe('HD0001, HD0002');
      expect(mockPrisma.productQualityTicketInvoice.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            { ticketId: 101, invoiceId: 11 },
            { ticketId: 101, invoiceId: 12 },
          ],
          skipDuplicates: true,
        }),
      );
    });
  });

  describe('assign handling direction and calculate dueAt', () => {
    it('sets handledAt and dueAt (5 days) on first handling', async () => {
      const existing = {
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.NEW,
        handledAt: null,
        dueAt: null,
        assignedDepartments: [],
        tasks: [],
      };
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue(existing);
      mockPrisma.productQualityTicket.update.mockResolvedValue({
        ...existing,
        status: QUALITY_STATUS.IN_PROGRESS,
        handlingDirection: 'Đổi hàng cho khách',
        assignedDepartments: ['Kho + Logistics', 'Kế Toán Kho'],
      });

      await service.assign(
        1,
        {
          handlingDirection: 'Đổi hàng cho khách',
          assignedDepartments: ['Kho + Logistics', 'Kế Toán Kho'],
        },
        1,
      );

      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            status: QUALITY_STATUS.IN_PROGRESS,
            handlingDirection: 'Đổi hàng cho khách',
            handledAt: expect.any(Date),
            dueAt: expect.any(Date),
          }),
        }),
      );
    });

    it('rejects moving to processing without any department', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.NEW,
        handledAt: null,
        assignedDepartments: [],
        tasks: [],
      });

      await expect(
        service.assign(
          1,
          { handlingDirection: 'Xử lý nội bộ', assignedDepartments: [] },
          1,
        ),
      ).rejects.toThrow('ít nhất một bộ phận');
    });

    it('updates reason/note and adds or removes attachments', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.IN_PROGRESS,
        handledAt: new Date(),
        reason: 'Nguyên nhân cũ',
        note: 'Ghi chú cũ',
        assignedDepartments: ['Kho + Logistics'],
        tasks: [{ department: 'Kho + Logistics', isCompleted: false }],
      });
      mockPrisma.productQualityTicket.update.mockResolvedValue({ id: 1 });

      await service.assign(
        1,
        {
          handlingDirection: 'Đổi hàng',
          assignedDepartments: ['Kho + Logistics'],
          reason: 'Nguyên nhân mới',
          note: 'Ghi chú mới',
          removeAttachmentIds: [10, 11],
          attachments: [
            {
              filename: 'anh-moi.jpg',
              url: '/uploads/product-quality/anh-moi.jpg',
              mimetype: 'image/jpeg',
              kind: 'PROOF_IMAGE',
            },
          ],
        },
        2,
      );

      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: 'Nguyên nhân mới',
            note: 'Ghi chú mới',
          }),
        }),
      );
      expect(mockPrisma.productQualityAttachment.deleteMany).toHaveBeenCalledWith({
        where: { ticketId: 1, id: { in: [10, 11] } },
      });
      expect(mockPrisma.productQualityAttachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: 1,
            filename: 'anh-moi.jpg',
            kind: 'PROOF_IMAGE',
          }),
        }),
      );
    });

    it('rejects updating a cancelled ticket', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.ENDED,
        assignedDepartments: ['Kho + Logistics'],
        tasks: [],
      });

      await expect(
        service.assign(
          1,
          {
            handlingDirection: 'Đổi hàng',
            assignedDepartments: ['Kho + Logistics'],
          },
          1,
        ),
      ).rejects.toThrow('đã hủy');
    });
  });

  describe('moveToRemediating', () => {
    it('sets status REMEDIATING when handling and departments exist', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.IN_PROGRESS,
        handlingDirection: 'Đổi hàng',
        assignedDepartments: ['Kho + Logistics'],
        decisionMakerId: 10,
        createdById: 1,
        tasks: [{ department: 'Kho + Logistics', isCompleted: false }],
      });
      mockPrisma.productQualityTicket.update.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.REMEDIATING,
      });

      await service.moveToRemediating(1, 2);

      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({ status: QUALITY_STATUS.REMEDIATING }),
        }),
      );
    });

    it('rejects when there is no handling direction', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.IN_PROGRESS,
        handlingDirection: null,
        assignedDepartments: ['Kho + Logistics'],
        tasks: [],
      });

      await expect(service.moveToRemediating(1, 2)).rejects.toThrow(
        'hướng xử lý',
      );
    });
  });

  describe('updateTask & auto status progression', () => {
    it('keeps REMEDIATING on partial completion and moves to COMPLETED when all complete', async () => {
      const ticket = {
        id: 1,
        code: 'CLSP000001',
        assignedDepartments: ['Kho + Logistics', 'Kế Toán Kho'],
        handledAt: new Date(),
        status: QUALITY_STATUS.REMEDIATING,
        tasks: [
          { department: 'Kho + Logistics', isCompleted: false },
          { department: 'Kế Toán Kho', isCompleted: false },
        ],
      };

      mockPrisma.productQualityTicket.findUnique.mockResolvedValue(ticket);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 2, name: 'Thủ kho' });

      // First department completes -> vẫn REMEDIATING
      mockPrisma.productQualityTask.findMany.mockResolvedValue([
        { department: 'Kho + Logistics', isCompleted: true },
        { department: 'Kế Toán Kho', isCompleted: false },
      ]);

      await service.updateTask(
        1,
        'Kho + Logistics',
        {
          isCompleted: true,
          feedback: 'Đã thu hồi hàng hỏng',
          attachments: [
            {
              filename: 'minh-chung-kho.jpg',
              url: '/uploads/product-quality/minh-chung-kho.jpg',
              mimetype: 'image/jpeg',
            },
          ],
        },
        2,
      );

      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            status: QUALITY_STATUS.REMEDIATING,
            isCompleted: false,
          }),
        }),
      );

      // Second department completes -> COMPLETED
      mockPrisma.productQualityTask.findMany.mockResolvedValue([
        { department: 'Kho + Logistics', isCompleted: true },
        { department: 'Kế Toán Kho', isCompleted: true },
      ]);

      await service.updateTask(
        1,
        'Kế Toán Kho',
        {
          isCompleted: true,
          feedback: 'Đã claim NCC',
          attachments: [
            {
              filename: 'minh-chung-ke-toan.jpg',
              url: '/uploads/product-quality/minh-chung-ke-toan.jpg',
              mimetype: 'image/jpeg',
            },
          ],
        },
        3,
      );

      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            status: QUALITY_STATUS.COMPLETED,
            isCompleted: true,
            completedAt: expect.any(Date),
          }),
        }),
      );
    });

    it('rejects completing a task without image proof', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000002',
        assignedDepartments: ['Kho + Logistics'],
        handledAt: new Date(),
        status: QUALITY_STATUS.REMEDIATING,
        tasks: [{ department: 'Kho + Logistics', isCompleted: false }],
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 2, name: 'Thủ kho' });
      mockPrisma.productQualityAttachment.findMany.mockResolvedValue([]);

      await expect(
        service.updateTask(
          1,
          'Kho + Logistics',
          { isCompleted: true, feedback: 'Xong' },
          2,
        ),
      ).rejects.toThrow('hình ảnh minh chứng');
    });

    it('does not auto-complete while the ticket is still IN_PROGRESS', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000003',
        assignedDepartments: ['Kho + Logistics'],
        handledAt: new Date(),
        status: QUALITY_STATUS.IN_PROGRESS,
        tasks: [{ department: 'Kho + Logistics', isCompleted: true }],
      });
      mockPrisma.user.findUnique.mockResolvedValue({ id: 2, name: 'Thủ kho' });
      mockPrisma.productQualityAttachment.findMany.mockResolvedValue([]);
      mockPrisma.productQualityTask.findMany.mockResolvedValue([
        { department: 'Kho + Logistics', isCompleted: true },
      ]);

      await service.updateTask(
        1,
        'Kho + Logistics',
        {
          isCompleted: true,
          feedback: 'Xong',
          attachments: [
            { filename: 'a.jpg', url: '/a.jpg', mimetype: 'image/jpeg' },
          ],
        },
        2,
      );

      const completionCall = mockPrisma.productQualityTicket.update.mock.calls.find(
        (c: any[]) => c[0]?.data?.status === QUALITY_STATUS.COMPLETED,
      );
      expect(completionCall).toBeUndefined();
    });
  });

  describe('close ticket', () => {
    it('sets status to ENDED with reason', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.REMEDIATING,
      });
      mockPrisma.productQualityTicket.update.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.ENDED,
        closeReason: 'Khách không đồng ý đổi',
      });

      const res = await service.close(1, { reason: 'Khách không đồng ý đổi' }, 1);
      expect(res.status).toBe(QUALITY_STATUS.ENDED);
      expect(res.closeReason).toBe('Khách không đồng ý đổi');
      expect(mockPrisma.productQualityTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: QUALITY_STATUS.ENDED,
            closeReason: 'Khách không đồng ý đổi',
            closedById: 1,
          }),
        }),
      );
    });

    it('rejects cancelling a completed ticket', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.COMPLETED,
      });

      await expect(
        service.close(1, { reason: 'Hủy' }, 1),
      ).rejects.toThrow('đã hoàn thành');
      expect(mockPrisma.productQualityTicket.update).not.toHaveBeenCalled();
    });

    it('rejects cancelling an already cancelled ticket', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.ENDED,
      });

      await expect(
        service.close(1, { reason: 'Hủy lần 2' }, 1),
      ).rejects.toThrow('đã được hủy trước đó');
      expect(mockPrisma.productQualityTicket.update).not.toHaveBeenCalled();
    });
  });

  describe('delete ticket', () => {
    it('never hard-deletes a ticket', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({
        id: 1,
        code: 'CLSP000001',
        status: QUALITY_STATUS.NEW,
      });

      await expect(service.delete(1, 1)).rejects.toThrow(
        'Không hỗ trợ xóa phiếu chất lượng',
      );
      expect(mockPrisma.productQualityTicket.delete).not.toHaveBeenCalled();
    });
  });
});
