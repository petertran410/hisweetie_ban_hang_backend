import { BadRequestException } from '@nestjs/common';
import { ApprovalLifecycleService } from './approval-lifecycle.service';

describe('ApprovalLifecycleService', () => {
  const user = { id: 7, larkUserId: 'ou_requester' };

  function createService(overrides: any = {}) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
      },
      branch: {
        findUnique: jest.fn().mockResolvedValue({
          id: 6,
          name: 'Kho Hà Nội',
          isActive: true,
        }),
      },
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 1,
          kind: 'EXPENSE_HN',
          approvalCode: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
          clientUuid: 'uuid-1',
          status: 'PENDING',
          formSnapshot: {},
        }),
        update: jest.fn().mockResolvedValue({
          id: 1,
          kind: 'EXPENSE_HN',
          approvalCode: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
          clientUuid: 'uuid-1',
          instanceCode: 'instance-1',
          status: 'PENDING',
        }),
        ...overrides.approvalRequest,
      },
      cashFlow: {
        findUnique: jest.fn().mockResolvedValue({ id: 99, branchId: 6 }),
      },
      approvalRequestEvent: {
        create: jest.fn().mockResolvedValue({ id: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
    };
    const larkClient = {
      tokenManager: {
        getTenantAccessToken: jest.fn().mockResolvedValue('tenant-token'),
      },
      approval: {
        v4: {
          instance: {
            create: jest.fn().mockResolvedValue({
              code: 0,
              data: { instance_code: 'instance-1' },
            }),
            get: jest.fn().mockResolvedValue({
              code: 0,
              data: {
                status: 'PENDING',
                task_list: [{ status: 'PENDING', node_name: 'Kế toán' }],
              },
            }),
          },
        },
      },
    };
    const cashFlowsService = {
      createApprovalCashFlow: jest.fn(),
    };
    const fundLedger = {
      applyApproval: jest.fn(),
      lockApproval: jest.fn(),
      lock: jest.fn(),
    };
    (prisma as any).$transaction = jest.fn(async (callback: any) =>
      callback(prisma),
    );
    const service = new ApprovalLifecycleService(
      prisma as any,
      { get: jest.fn() } as any,
      larkClient as any,
      fundLedger as any,
    );
    return { service, prisma, larkClient, cashFlowsService, fundLedger };
  }

  const hnForm = [
    { id: 'widget17399397879320001', type: 'input', value: '39' },
    { id: 'widget17399508033270001', type: 'input', value: '2026-09-21' },
    { id: 'widget17399508090490001', type: 'input', value: '2026-09-27' },
    { id: 'widget17368415755750001', type: 'amount', value: 1000000 },
    { id: 'widget17368416610880001', type: 'input', value: 'Chi xăng' },
    { id: 'widget17371739587940001', type: 'input', value: 'POS #1' },
  ];

  it('automatically posts an approved fund receipt in the approval-status transaction', async () => {
    const request = {
      id: 19,
      status: 'PENDING',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      sourceId: null,
      instanceCode: 'fund-19',
      approvalCode: 'receipt-template',
      lastEventAt: null,
    };
    const f = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue(request),
        update: jest.fn().mockResolvedValue({ ...request, status: 'APPROVED' }),
      },
    });
    (f.prisma as any).$transaction = jest.fn(async (callback) =>
      callback(f.prisma),
    );
    await f.service.handleInstanceEvent({
      instance_code: 'fund-19',
      approval_code: 'receipt-template',
      status: 'APPROVED',
    });
    expect((f.prisma as any).$transaction).toHaveBeenCalled();
    expect(f.fundLedger.applyApproval).toHaveBeenCalledWith(
      f.prisma,
      expect.objectContaining({
        id: 19,
        status: 'APPROVED',
        sourceType: 'INTERNAL_FUND_RECEIPT',
      }),
    );
    expect(f.cashFlowsService.createApprovalCashFlow).not.toHaveBeenCalled();
  });

  it('does not let a delayed pending callback overwrite approved status', async () => {
    const request = {
      id: 31,
      status: 'PENDING',
      sourceType: 'INTERNAL_FUND_RECEIPT',
      sourceId: null,
      instanceCode: 'fund-31',
      approvalCode: 'receipt-template',
      lastEventAt: null,
    };
    const state = { ...request };
    const f = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue(state),
        update: jest.fn().mockImplementation(async ({ data }) => {
          Object.assign(state, data);
          return { ...state };
        }),
      },
    });
    (f.prisma as any).$transaction = jest.fn(async (callback) =>
      callback(f.prisma),
    );

    await f.service.handleInstanceEvent({
      instance_code: 'fund-31',
      approval_code: 'receipt-template',
      status: 'APPROVED',
      instance_operate_time: '2026-10-06T03:01:00Z',
    });
    await f.service.handleInstanceEvent({
      instance_code: 'fund-31',
      approval_code: 'receipt-template',
      status: 'PENDING',
      instance_operate_time: '2026-10-06T03:00:00Z',
    });

    expect(state.status).toBe('APPROVED');
    expect(f.fundLedger.applyApproval).toHaveBeenCalledTimes(1);
  });

  it('excludes internal-fund approvals from the legacy approval list', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const f = createService({
      approvalRequest: {
        findMany,
        count,
      },
    });

    await f.service.findAll({ page: 1, limit: 30 } as any);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { sourceType: null },
                {
                  sourceType: {
                    notIn: ['INTERNAL_FUND_RECEIPT', 'INTERNAL_FUND_TRANSFER'],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
  });

  it('creates a HN approval with the requester open_id and idempotency uuid', async () => {
    const { service, larkClient } = createService();

    const result = await service.create(
      {
        kind: 'EXPENSE_HN',
        clientUuid: 'uuid-1',
        branchId: 6,
        form: hnForm,
      },
      7,
    );

    expect(larkClient.approval.v4.instance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
        open_id: 'ou_requester',
        uuid: 'uuid-1',
        form: JSON.stringify(hnForm),
      }),
    });
    expect(result.instanceCode).toBe('instance-1');
  });

  it('returns the existing request without creating a duplicate approval', async () => {
    const existing = {
      id: 2,
      kind: 'EXPENSE_HN',
      approvalCode: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      clientUuid: 'uuid-1',
      instanceCode: 'instance-existing',
      status: 'PENDING',
    };
    const { service, larkClient } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    });

    const result = await service.create(
      { kind: 'EXPENSE_HN', clientUuid: 'uuid-1', form: hnForm },
      7,
    );

    expect(result.instanceCode).toBe('instance-existing');
    expect(larkClient.approval.v4.instance.create).not.toHaveBeenCalled();
  });

  it('creates a SG approval with the SG approval code', async () => {
    const { service, larkClient } = createService();
    const sgForm = hnForm.map((item) => {
      if (item.id === 'widget17399397879320001') {
        return { ...item, id: 'widget17399388386300001' };
      }
      if (item.id === 'widget17399508033270001') {
        return { ...item, id: 'widget17399508904720001' };
      }
      if (item.id === 'widget17399508090490001') {
        return { ...item, id: 'widget17399508961760001' };
      }
      return item;
    });

    await service.create(
      {
        kind: 'EXPENSE_SG',
        clientUuid: 'uuid-sg-1',
        branchId: 1,
        form: sgForm,
      },
      7,
    );

    expect(larkClient.approval.v4.instance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approval_code: 'AE8660B8-4467-45FE-9878-F3B649372E8C',
        uuid: 'uuid-sg-1',
      }),
    });
  });

  it('rejects a receipt transfer without both source and destination', async () => {
    const { service } = createService();

    await expect(
      service.create(
        {
          kind: 'RECEIPT',
          form: [
            {
              id: 'widget17321740179360001',
              type: 'radioV2',
              value: 'miior6p8-s0rjayqbcv-1',
            },
            {
              id: 'widget17321810360090001',
              type: 'contact',
              value: ['ou_requester'],
            },
            {
              id: 'widget17321631178550001',
              type: 'date',
              value: '2026-09-26',
            },
            {
              id: 'widget17321728506550001',
              type: 'radioV2',
              value: 'md9r0rqr-tlntv5zjg8-1',
            },
            {
              id: 'widget17730449889490001',
              type: 'radioV2',
              value: 'mmix7h92-hukohb4on6-0',
            },
            {
              id: 'widget17321628654580001',
              type: 'textarea',
              value: 'Nộp quỹ',
            },
            {
              id: 'widget17321629138780001',
              type: 'amount',
              value: 100000,
            },
          ],
        },
        7,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows VP transfer payment without a cash source', async () => {
    const { service, larkClient } = createService();

    await service.create(
      {
        kind: 'EXPENSE_VP',
        branchId: 4,
        form: [
          { id: 'widget17399388386300001', type: 'input', value: '39' },
          {
            id: 'widget17399508904720001',
            type: 'input',
            value: '2026-09-21',
          },
          {
            id: 'widget17399508961760001',
            type: 'input',
            value: '2026-09-27',
          },
          {
            id: 'widget17368415755750001',
            type: 'amount',
            value: 1000000,
          },
          {
            id: 'widget17368416610880001',
            type: 'input',
            value: 'Chi văn phòng',
          },
          {
            id: 'widget17371739587940001',
            type: 'input',
            value: 'POS #VP',
          },
          {
            id: 'widget17700954766870001',
            type: 'radioV2',
            value: 'ml65570v-qr4uobqvu9-0',
          },
        ],
      },
      7,
    );

    expect(larkClient.approval.v4.instance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approval_code: 'B06392C2-EE34-486B-AA9C-DB7C53C19142',
      }),
    });
  });

  it('requires a cash source for VP cash payment', async () => {
    const { service } = createService();

    await expect(
      service.create(
        {
          kind: 'EXPENSE_VP',
          branchId: 4,
          form: [
            { id: 'widget17399388386300001', type: 'input', value: '39' },
            {
              id: 'widget17399508904720001',
              type: 'input',
              value: '2026-09-21',
            },
            {
              id: 'widget17399508961760001',
              type: 'input',
              value: '2026-09-27',
            },
            {
              id: 'widget17368415755750001',
              type: 'amount',
              value: 1000000,
            },
            {
              id: 'widget17368416610880001',
              type: 'input',
              value: 'Chi văn phòng',
            },
            {
              id: 'widget17371739587940001',
              type: 'input',
              value: 'POS #VP',
            },
            {
              id: 'widget17700954766870001',
              type: 'radioV2',
              value: 'ml65570v-ih3r0g47mu-0',
            },
          ],
        },
        7,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an expense period whose start date is after its end date', async () => {
    const { service } = createService();

    await expect(
      service.create(
        {
          kind: 'EXPENSE_HN',
          branchId: 6,
          form: hnForm.map((item) =>
            item.id === 'widget17399508033270001'
              ? { ...item, value: '2026-09-28' }
              : item.id === 'widget17399508090490001'
                ? { ...item, value: '2026-09-27' }
                : item,
          ),
        },
        7,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a receipt transfer with distinct valid location option values', async () => {
    const { service, larkClient } = createService();

    await service.create(
      {
        kind: 'RECEIPT',
        branchId: 6,
        form: [
          {
            id: 'widget17321740179360001',
            type: 'radioV2',
            value: 'miior6p8-s0rjayqbcv-1',
          },
          {
            id: 'widget17321631178550001',
            type: 'date',
            value: '2026-09-26',
          },
          {
            id: 'widget17321728506550001',
            type: 'radioV2',
            value: 'md9r0rqr-tlntv5zjg8-1',
          },
          {
            id: 'widget17730449889490001',
            type: 'radioV2',
            value: 'mmix7h92-hukohb4on6-0',
          },
          {
            id: 'widget17321628654580001',
            type: 'textarea',
            value: 'Chuyển quỹ',
          },
          {
            id: 'widget17321629138780001',
            type: 'amount',
            value: 500000,
          },
          {
            id: 'widget17863314165550001',
            type: 'radioV2',
            value: 'msmnlqej-t6tk3qikgcm-0',
          },
          {
            id: 'widget17863314190270001',
            type: 'radioV2',
            value: 'msmnlsb8-8wr2wdb09lx-0',
          },
          {
            id: 'widget17321767077360001',
            type: 'attachmentV2',
            value: ['invoice-token'],
          },
        ],
      },
      7,
    );

    expect(larkClient.approval.v4.instance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        approval_code: '09CFDCE2-D026-44C7-A94C-8C6B02660BA1',
      }),
    });
  });

  it('ignores duplicate approval events', async () => {
    const duplicate = Object.assign(new Error('unique'), { code: 'P2002' });
    const { service, prisma } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          instanceCode: 'instance-1',
          status: 'PENDING',
          lastEventAt: null,
        }),
      },
    });
    prisma.approvalRequestEvent = {
      create: jest.fn().mockRejectedValue(duplicate),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 1, processedAt: new Date() }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };

    await expect(
      service.handleInstanceEvent({
        approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
        instance_code: 'instance-1',
        status: 'PENDING',
        instance_operate_time: '1790440000000',
      }),
    ).resolves.toBeUndefined();
  });

  it('refreshes status and current node after a new event', async () => {
    const { service, prisma } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          instanceCode: 'instance-1',
          status: 'PENDING',
          lastEventAt: null,
        }),
        update: jest.fn().mockResolvedValue({
          id: 1,
          status: 'APPROVED',
          currentNode: 'Kế toán',
        }),
      },
    });
    prisma.approvalRequestEvent = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };

    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-1',
      status: 'APPROVED',
      instance_operate_time: '1790440000000',
      uuid: 'event-1',
    });

    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          status: 'APPROVED',
          currentNode: 'Kế toán',
          lastEventUuid: 'event-1',
        }),
      }),
    );
  });

  it('does not post money when an approval event becomes APPROVED', async () => {
    const { service, cashFlowsService } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 7,
          instanceCode: 'instance-7',
          status: 'PENDING',
          lastEventAt: null,
        }),
      },
    });

    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-7',
      status: 'APPROVED',
      instance_operate_time: '1790440000000',
    });

    expect(cashFlowsService.createApprovalCashFlow).not.toHaveBeenCalled();
  });

  it('reconciles a pending request when the webhook was missed', async () => {
    const { service, prisma, larkClient } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 8,
          instanceCode: 'instance-8',
          status: 'PENDING',
          lastEventAt: null,
        }),
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 8, instanceCode: 'instance-8', status: 'PENDING' },
          ]),
      },
    });
    larkClient.approval.v4.instance.get.mockResolvedValue({
      code: 0,
      data: {
        status: 'APPROVED',
        tasks: [{ status: 'APPROVED', node_name: 'Kế toán' }],
        current_nodes: [],
        operation_records: [],
      },
    });

    await service.reconcilePending();

    expect(larkClient.approval.v4.instance.get).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { instance_id: 'instance-8' },
      }),
    );
    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 8 },
        data: expect.objectContaining({ status: 'APPROVED' }),
      }),
    );
  });

  it('reads current nodes, tasks, and timeline from the Lark detail shape', async () => {
    const { service } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 31,
          kind: 'EXPENSE_HN',
          approvalCode: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
          clientUuid: 'uuid-31',
          instanceCode: 'instance-31',
          status: 'PENDING',
          currentNode: 'Kế toán',
          branchId: 6,
          cashFlowId: null,
          createdAt: new Date('2026-09-26T08:00:00.000Z'),
          updatedAt: new Date('2026-09-26T08:01:00.000Z'),
          completedAt: null,
          detailSnapshot: {
            tasks: [
              {
                id: 'task-1',
                status: 'PENDING',
                user_id: 'ou-approver',
                node_name: 'Kế toán',
              },
            ],
            current_nodes: [
              {
                node_name: 'Kế toán',
                approvers: [{ task_id: 'task-1', user_id: 'ou-approver' }],
              },
            ],
            operation_records: [
              { type: 'START', create_time: '1790400000000' },
            ],
          },
          events: [],
        }),
      },
    });

    const result = await service.findOne(31);

    expect(result.taskList).toEqual([
      expect.objectContaining({ id: 'task-1', node_name: 'Kế toán' }),
    ]);
    expect(result.currentApprovers).toEqual([
      { taskId: 'task-1', userId: 'ou-approver' },
    ]);
    expect(result.timeline).toEqual([
      expect.objectContaining({ type: 'START' }),
    ]);
  });

  it('does not let a later terminal event overwrite an earlier terminal status', async () => {
    let currentStatus = 'PENDING';
    const { service, prisma, larkClient } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockImplementation(({ where }: any) => {
          if (where.instanceCode || where.clientUuid) {
            return Promise.resolve({
              id: 1,
              instanceCode: 'instance-1',
              clientUuid: 'uuid-1',
              status: currentStatus,
              lastEventAt:
                currentStatus === 'APPROVED'
                  ? new Date('2026-09-26T10:00:00.000Z')
                  : null,
            });
          }
          return Promise.resolve({
            id: 1,
            status: currentStatus,
            lastEventAt:
              currentStatus === 'APPROVED'
                ? new Date('2026-09-26T10:00:00.000Z')
                : null,
          });
        }),
        update: jest.fn().mockImplementation(({ data }: any) => {
          currentStatus = data.status;
          return Promise.resolve({ id: 1, status: currentStatus });
        }),
      },
    });
    prisma.approvalRequestEvent = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };

    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-1',
      status: 'APPROVED',
      instance_operate_time: String(
        new Date('2026-09-26T10:00:00.000Z').getTime(),
      ),
    });
    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-1',
      status: 'REJECTED',
      instance_operate_time: String(
        new Date('2026-09-26T10:01:00.000Z').getTime(),
      ),
    });

    expect(currentStatus).toBe('APPROVED');
    expect(larkClient.approval.v4.instance.get).toHaveBeenCalledTimes(1);
  });

  it.each(['REJECTED', 'CANCELED', 'DELETED', 'REVERTED'])(
    'does not post a CashFlow for %s approval',
    async (status) => {
      const { service } = createService({
        approvalRequest: {
          findUnique: jest.fn().mockResolvedValue({
            id: 22,
            kind: 'EXPENSE_HN',
            status,
            branchId: 6,
            cashFlowId: null,
            instanceCode: 'instance-22',
            formSnapshot: { form: hnForm },
          }),
        },
      });
      const cashFlowsService = {
        createApprovalCashFlow: jest.fn(),
        createApprovalTransferCashFlows: jest.fn(),
      };
      const guardedService = new ApprovalLifecycleService(
        (service as any).prisma,
        { get: jest.fn() } as any,
        {} as any,
        { applyApproval: jest.fn() } as any,
      );

      await expect(guardedService.postCashFlow(22, 7)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(cashFlowsService.createApprovalCashFlow).not.toHaveBeenCalled();
      expect(
        cashFlowsService.createApprovalTransferCashFlows,
      ).not.toHaveBeenCalled();
    },
  );

  it('uploads an Approval attachment through the Lark upload endpoint', async () => {
    const { service } = createService();
    const previousFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          data: { code: 'file-code-1', url: 'https://lark/file-1' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    try {
      const result = await service.uploadFile(
        {
          buffer: Buffer.from('approval'),
          size: 8,
          originalname: 'receipt.pdf',
          mimetype: 'application/pdf',
        } as Express.Multer.File,
        'attachment',
      );

      expect(result).toEqual({
        code: 'file-code-1',
        url: 'https://lark/file-1',
        name: 'receipt.pdf',
        type: 'attachment',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://www.larksuite.com/approval/openapi/v2/file/upload',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer tenant-token' },
        }),
      );
    } finally {
      global.fetch = previousFetch;
    }
  });

  it('rejects posting an approved internal expense to CashFlow', async () => {
    const { service, prisma } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 12,
          kind: 'EXPENSE_HN',
          status: 'APPROVED',
          branchId: 6,
          cashFlowId: null,
          instanceCode: 'instance-12',
          formSnapshot: {
            form: [
              {
                id: 'widget17368415755750001',
                value: 1500000,
              },
              {
                id: 'widget17399508033270001',
                value: '2026-09-26',
              },
              {
                id: 'widget17368416610880001',
                value: 'Chi xăng xe',
              },
            ],
          },
        }),
      },
    });

    const cashFlowsService = {
      createApprovalCashFlow: jest.fn().mockResolvedValue({
        cashFlow: { id: 44 },
        alreadyPosted: false,
      }),
    };
    const serviceWithCashFlow = new ApprovalLifecycleService(
      prisma as any,
      { get: jest.fn() } as any,
      {
        tokenManager: { getTenantAccessToken: jest.fn() },
        approval: { v4: { instance: {} } },
      } as any,
      { applyApproval: jest.fn() } as any,
    );

    await expect(serviceWithCashFlow.postCashFlow(12, 7)).rejects.toThrow(
      'không tạo CashFlow',
    );
    expect(cashFlowsService.createApprovalCashFlow).not.toHaveBeenCalled();
  });

  it('rejects posting an approved internal transfer to CashFlow', async () => {
    const transferService = {
      createApprovalTransferCashFlows: jest.fn().mockResolvedValue({
        cashFlows: [{ id: 51 }, { id: 52 }],
        alreadyPosted: false,
      }),
      createApprovalCashFlow: jest.fn(),
    };
    const prisma = {
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 15,
          kind: 'RECEIPT',
          status: 'APPROVED',
          branchId: 6,
          cashFlowId: null,
          instanceCode: 'receipt-15',
          formSnapshot: {
            form: [
              {
                id: 'widget17321740179360001',
                value: 'miior6p8-s0rjayqbcv-1',
              },
              {
                id: 'widget17321631178550001',
                value: '2026-09-26',
              },
              {
                id: 'widget17321728506550001',
                value: 'm3sj5uh2-zttr08nfqcm-1',
              },
              {
                id: 'widget17321629138780001',
                value: 500000,
              },
              {
                id: 'widget17321628654580001',
                value: 'Chuyển quỹ',
              },
              {
                id: 'widget17863314165550001',
                value: 'msmnlqej-t6tk3qikgcm-0',
              },
              {
                id: 'widget17863314190270001',
                value: 'msmnlsb8-8wr2wdb09lx-0',
              },
            ],
          },
        }),
      },
    };
    const service = new ApprovalLifecycleService(
      prisma as any,
      { get: jest.fn() } as any,
      {} as any,
      { applyApproval: jest.fn() } as any,
    );

    await expect(service.postCashFlow(15, 7)).rejects.toThrow(
      'không tạo CashFlow',
    );
    expect(
      transferService.createApprovalTransferCashFlows,
    ).not.toHaveBeenCalled();
  });

  it('returns only approved temporary advances with remaining balance', async () => {
    const prisma = {} as any;
    const larkClient = {
      bitable: {
        appTableRecord: {
          search: jest.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  record_id: 'rec-parent',
                  fields: {
                    'Tên phiếu tạm ứng': 'Tạm ứng tháng 9',
                    'Nội dung tạm ứng': 'Chi phí kho',
                    'Còn Lại': '-500000',
                    'Đã Duyệt (Kế toán)': ['Duyệt'],
                  },
                },
                {
                  record_id: 'rec-child',
                  fields: {
                    'Tên phiếu tạm ứng': null,
                    'Nội dung tạm ứng': 'Dòng chi tiết',
                    'Còn Lại': '-100000',
                    'Đã Duyệt (Kế toán)': ['Duyệt'],
                  },
                },
                {
                  record_id: 'rec-settled',
                  fields: {
                    'Tên phiếu tạm ứng': 'Đã hoàn ứng',
                    'Nội dung tạm ứng': 'Đã tất toán',
                    'Còn Lại': '0',
                    'Đã Duyệt (Kế toán)': ['Duyệt'],
                  },
                },
              ],
            },
          }),
        },
      },
    };
    const service = new ApprovalLifecycleService(
      prisma,
      { get: jest.fn().mockReturnValue('base-token') } as any,
      larkClient as any,
      { applyApproval: jest.fn() } as any,
    );

    const result = await service.findTempAdvanceOptions();

    expect(result.data).toEqual([
      expect.objectContaining({
        value: 'Tạm ứng tháng 9',
        remaining: -500000,
      }),
    ]);
  });

  it('records DELETED even when Lark no longer returns instance detail', async () => {
    const { service, prisma, larkClient } = createService({
      approvalRequest: {
        findUnique: jest.fn().mockResolvedValue({
          id: 21,
          instanceCode: 'deleted-instance',
          status: 'PENDING',
          lastEventAt: null,
        }),
      },
    });
    larkClient.approval.v4.instance.get.mockRejectedValue(
      new Error('instance code not found'),
    );
    prisma.approvalRequestEvent = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    };

    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'deleted-instance',
      status: 'DELETED',
      instance_operate_time: '1790440000000',
    });

    expect(prisma.approvalRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DELETED',
          completedAt: expect.any(Date),
        }),
      }),
    );
  });
});
