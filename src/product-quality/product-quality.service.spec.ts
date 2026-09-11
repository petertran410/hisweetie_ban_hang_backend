import { ProductQualityService, QUALITY_STATUS } from './product-quality.service';

describe('ProductQualityService (Unit)', () => {
  let service: ProductQualityService;
  let mockPrisma: any;
  let mockNotifications: any;
  let mockAuditLogs: any;
  let mockConfig: any;
  let mockImportService: any;

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
  });

  describe('updateTask & auto status progression', () => {
    it('transitions to REMEDIATING when partial tasks complete, and COMPLETED when all complete', async () => {
      const ticket = {
        id: 1,
        code: 'CLSP000001',
        assignedDepartments: ['Kho + Logistics', 'Kế Toán Kho'],
        handledAt: new Date(),
        status: QUALITY_STATUS.IN_PROGRESS,
        tasks: [
          { department: 'Kho + Logistics', isCompleted: false },
          { department: 'Kế Toán Kho', isCompleted: false },
        ],
      };

      mockPrisma.productQualityTicket.findUnique.mockResolvedValue(ticket);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 2, name: 'Thủ kho' });

      // First department completes -> REMEDIATING
      mockPrisma.productQualityTask.findMany.mockResolvedValue([
        { department: 'Kho + Logistics', isCompleted: true },
        { department: 'Kế Toán Kho', isCompleted: false },
      ]);

      await service.updateTask(
        1,
        'Kho + Logistics',
        { isCompleted: true, feedback: 'Đã thu hồi hàng hỏng' },
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
        { isCompleted: true, feedback: 'Đã claim NCC' },
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
  });

  describe('close ticket', () => {
    it('sets status to ENDED with reason', async () => {
      mockPrisma.productQualityTicket.findUnique.mockResolvedValue({ id: 1 });
      mockPrisma.productQualityTicket.update.mockResolvedValue({
        id: 1,
        status: QUALITY_STATUS.ENDED,
        closeReason: 'Khách không đồng ý đổi',
      });

      const res = await service.close(1, { reason: 'Khách không đồng ý đổi' }, 1);
      expect(res.status).toBe(QUALITY_STATUS.ENDED);
      expect(res.closeReason).toBe('Khách không đồng ý đổi');
    });
  });
});
