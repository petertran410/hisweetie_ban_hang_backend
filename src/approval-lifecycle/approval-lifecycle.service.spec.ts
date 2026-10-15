import { BadRequestException } from '@nestjs/common';
import { ApprovalLifecycleService } from './approval-lifecycle.service';

function larkMirrorStub() {
  return {
    inspect: jest.fn().mockResolvedValue({
      summary: { inScope: false, skipReason: 'Ngoài phạm vi' },
      suspectDuplicateOfId: null,
    }),
    save: jest.fn(),
    ensureEntry: jest.fn(),
    linkRequest: jest.fn(),
    hasLedgerTwin: jest.fn().mockResolvedValue(false),
    settledCodes: jest.fn().mockResolvedValue(new Set()),
  };
}

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
      applyPaymentVoucher: jest.fn(),
      applyWarehouseExpense: jest.fn(),
      lockApproval: jest.fn(),
      lock: jest.fn(),
    };
    (prisma as any).$transaction = jest.fn(async (callback: any) =>
      callback(prisma),
    );
    const larkMirror = overrides.larkMirror || larkMirrorStub();
    const service = new ApprovalLifecycleService(
      prisma as any,
      { get: jest.fn() } as any,
      larkClient as any,
      fundLedger as any,
      larkMirror as any,
    );
    return {
      service,
      prisma,
      larkClient,
      cashFlowsService,
      fundLedger,
      larkMirror,
    };
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
                    notIn: [
                      'INTERNAL_FUND_RECEIPT',
                      'INTERNAL_FUND_TRANSFER',
                      'LARK_PAYMENT_VOUCHER',
                    ],
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

  it('auto-issues every warehouse expense when the weekly approval is approved, and reverts on recall', async () => {
    const request: any = {
      id: 7,
      instanceCode: 'instance-7',
      status: 'PENDING',
      lastEventAt: null,
      sourceType: 'INTERNAL_FINANCE_WEEKLY',
      sourceId: 4,
    };
    const { service, prisma, fundLedger } = createService({
      approvalRequest: {
        findUnique: jest.fn(async () => request),
        update: jest.fn(async ({ data }: any) => Object.assign(request, data)),
      },
    });
    (prisma as any).internalFinanceWeeklyBatch = {
      findUnique: jest.fn().mockResolvedValue({ branchId: 6, createdBy: 9 }),
      update: jest.fn(),
    };
    (prisma as any).internalFinanceEntry = { updateMany: jest.fn() };
    (fundLedger as any).issueApprovedBatch = jest.fn();
    (fundLedger as any).revertApprovedBatch = jest.fn();
    const event = {
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-7',
    };

    await service.handleInstanceEvent({
      ...event,
      status: 'APPROVED',
      instance_operate_time: '1790440000000',
      uuid: 'approved',
    });
    expect((fundLedger as any).issueApprovedBatch).toHaveBeenCalledWith(
      prisma,
      4,
      7,
      9,
    );
    expect((fundLedger as any).revertApprovedBatch).not.toHaveBeenCalled();
    // Tuần tạo trên POS vốn chỉ gồm phiếu đủ hai tick: không gỡ phiếu nào.
    expect(
      (prisma as any).internalFinanceEntry.updateMany.mock.calls.some(
        ([args]: any[]) => args.data?.weeklyBatchId === null,
      ),
    ).toBe(false);

    await service.handleInstanceEvent({
      ...event,
      status: 'REVERTED',
      instance_operate_time: '1790440001000',
      uuid: 'reverted',
    });
    expect((fundLedger as any).revertApprovedBatch).toHaveBeenCalledWith(
      prisma,
      4,
      7,
      9,
    );
  });

  it('handles an approval for a week synced from Lark while it was still pending', async () => {
    const request: any = {
      id: 11,
      instanceCode: 'instance-11',
      status: 'PENDING',
      lastEventAt: null,
      sourceType: 'LARK_IMPORT_WEEKLY',
      sourceId: 5,
    };
    const { service, prisma, fundLedger } = createService({
      approvalRequest: {
        findUnique: jest.fn(async () => request),
        update: jest.fn(async ({ data }: any) => Object.assign(request, data)),
      },
    });
    const batchUpdate = jest.fn();
    (prisma as any).internalFinanceWeeklyBatch = {
      findUnique: jest.fn().mockResolvedValue({ branchId: 6, createdBy: 9 }),
      update: batchUpdate,
    };
    (prisma as any).internalFinanceEntry = { updateMany: jest.fn() };
    (fundLedger as any).issueApprovedBatch = jest.fn();

    await service.handleInstanceEvent({
      approval_code: 'E759B9DB-B8EA-4DC6-B309-2E162D94EEF3',
      instance_code: 'instance-11',
      status: 'APPROVED',
      instance_operate_time: '1790440000000',
      uuid: 'approved-11',
    });

    expect(batchUpdate).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: 'APPROVED' },
    });
    // Phiếu chưa đủ hai tick bị gỡ khỏi tuần đồng bộ trước khi ghi quỹ.
    expect(
      (prisma as any).internalFinanceEntry.updateMany,
    ).toHaveBeenCalledWith({
      where: {
        weeklyBatchId: 5,
        cashIssued: false,
        cashFlowId: null,
        OR: [{ managerReviewedAt: null }, { accountantReviewedAt: null }],
      },
      data: { weeklyBatchId: null, status: 'PENDING_ACCOUNTANT' },
    });
    expect((fundLedger as any).issueApprovedBatch).toHaveBeenCalledWith(
      prisma,
      5,
      11,
      9,
    );
  });

  it('keeps every Kho SG entry in a synced week on approval (SG never used the two ticks)', async () => {
    const request: any = {
      id: 14,
      instanceCode: 'instance-14',
      status: 'PENDING',
      lastEventAt: null,
      sourceType: 'LARK_IMPORT_WEEKLY',
      sourceId: 8,
    };
    const { service, prisma, fundLedger } = createService({
      approvalRequest: {
        findUnique: jest.fn(async () => request),
        update: jest.fn(async ({ data }: any) => Object.assign(request, data)),
      },
    });
    (prisma as any).internalFinanceWeeklyBatch = {
      findUnique: jest.fn().mockResolvedValue({ branchId: 1, createdBy: 9 }),
      update: jest.fn(),
    };
    const updateMany = jest.fn();
    (prisma as any).internalFinanceEntry = { updateMany };
    (fundLedger as any).issueApprovedBatch = jest.fn();

    await service.handleInstanceEvent({
      approval_code: 'AE8660B8-0E5F-4F2B-A8B1-8E9C0A5A6C3D',
      instance_code: 'instance-14',
      status: 'APPROVED',
      instance_operate_time: '1790440000000',
      uuid: 'approved-14',
    });

    expect(
      updateMany.mock.calls.some(
        ([args]: any[]) => args.data?.weeklyBatchId === null,
      ),
    ).toBe(false);
    expect((fundLedger as any).issueApprovedBatch).toHaveBeenCalledWith(
      prisma,
      8,
      14,
      9,
    );
  });

  it('repairs synced weeks whose approval result arrived before the fix, once at startup', async () => {
    // Đơn tuần đồng bộ đã duyệt và POS đã nhận kết quả trực tiếp.
    const findMany = jest.fn().mockResolvedValue([
      {
        id: 12,
        status: 'APPROVED',
        sourceId: 6,
        createdAt: new Date('2026-10-13T15:41:00Z'),
        detailSnapshot: {
          end_time: String(Date.parse('2026-10-14T00:55:00Z')),
        },
      },
      // Tuần lịch sử: Lark duyệt từ 2025, chỉ được hỏi lại sau khi nhập.
      {
        id: 13,
        status: 'APPROVED',
        sourceId: 7,
        createdAt: new Date('2026-10-13T15:41:00Z'),
        detailSnapshot: {
          end_time: String(Date.parse('2025-03-20T08:56:00Z')),
        },
      },
    ]);
    const { service, prisma, fundLedger } = createService({
      approvalRequest: { findMany },
    });
    const batchFindMany = jest.fn().mockResolvedValue([{ id: 6 }]);
    (prisma as any).internalFinanceWeeklyBatch = {
      findMany: batchFindMany,
      findUnique: jest.fn().mockResolvedValue({ branchId: 1, createdBy: 3 }),
      update: jest.fn(),
    };
    (prisma as any).internalFinanceEntry = { updateMany: jest.fn() };
    (fundLedger as any).issueApprovedBatch = jest.fn();

    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    expect(findMany.mock.calls[0][0].where).toMatchObject({
      sourceType: 'LARK_IMPORT_WEEKLY',
      detailSnapshot: { not: expect.anything() },
    });
    const where = batchFindMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ id: { in: [6] }, status: 'IN_APPROVAL' });
    // Tuần đã bị đặt thẳng "Đã duyệt": chỉ kho, chỉ khi chưa phiếu nào Đã chi.
    expect(where.OR[1]).toEqual({
      id: { in: [6] },
      status: 'APPROVED',
      branchId: { in: [1, 6] },
      entries: { none: { cashIssued: true } },
    });
    expect((fundLedger as any).issueApprovedBatch).toHaveBeenCalledWith(
      prisma,
      6,
      12,
      3,
    );
  });

  it('only looks at weeks whose approval result POS received itself', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service, prisma } = createService({
      approvalRequest: { findMany },
    });
    const batchFindMany = jest.fn();
    (prisma as any).internalFinanceWeeklyBatch = { findMany: batchFindMany };

    service.onApplicationBootstrap();
    await new Promise((resolve) => setImmediate(resolve));

    // Tuần lịch sử không có detailSnapshot nên không nằm trong danh sách.
    expect(findMany.mock.calls[0][0].where.detailSnapshot).toBeDefined();
    expect(batchFindMany).not.toHaveBeenCalled();
  });

  it('does not throw at startup when the repair fails', async () => {
    const { service } = createService({
      approvalRequest: {
        findMany: jest.fn().mockRejectedValue(new Error('DB chưa sẵn sàng')),
      },
    });
    expect(() => service.onApplicationBootstrap()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
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
        larkMirrorStub() as any,
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
      larkMirrorStub() as any,
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
      larkMirrorStub() as any,
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
      larkMirrorStub() as any,
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
  describe('Lark-created PHIẾU CHI', () => {
    const voucherCode = '2A4BC15D-09F4-44FB-8B51-FD3174D5963B';
    const voucherForm = (
      method: string,
      source: string,
      cashAmount?: number,
    ) => [
      { id: 'widget17321753417610001', type: 'radioV2', value: method },
      { id: 'widget17643292059530001', type: 'radioV2', value: source },
      { id: 'widget17321752802850001', type: 'amount', value: 9000000 },
      { id: 'widget17321750170610001', type: 'input', value: 'Mua bìa' },
      ...(cashAmount
        ? [{ id: 'widget17643300136400001', type: 'amount', value: cashAmount }]
        : []),
    ];
    function voucherService(form: any[]) {
      const requests: any[] = [];
      const events: any[] = [];
      const f = createService({
        approvalRequest: {
          findUnique: jest.fn(
            async ({ where }: any) =>
              requests.find(
                (row) =>
                  row.id === where.id ||
                  (where.instanceCode &&
                    row.instanceCode === where.instanceCode),
              ) || null,
          ),
          create: jest.fn(async ({ data }: any) => {
            const row = { id: 50, lastEventAt: null, ...data };
            requests.push(row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) =>
            Object.assign(
              requests.find((row) => row.id === where.id),
              data,
            ),
          ),
        },
      });
      (f.prisma.user as any).findFirst = jest.fn().mockResolvedValue({ id: 9 });
      f.prisma.approvalRequestEvent = {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: events.length + 1, ...data };
          events.push(row);
          return row;
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async () =>
          events.filter((row) => !row.approvalRequestId),
        ),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            events.find((row) => row.id === where.id),
            data,
          ),
        ),
        updateMany: jest.fn(),
      } as any;
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: {
          status: 'APPROVED',
          open_id: 'ou_requester',
          serial_number: '202610010012',
          form: JSON.stringify(form),
        },
      });
      return { ...f, requests, events };
    }
    const approvedEvent = {
      approval_code: voucherCode,
      instance_code: 'D2688DAB',
      status: 'APPROVED',
      instance_operate_time: '1792000000000',
    };

    it('ingests an approved cash voucher and posts it to the warehouse fund', async () => {
      const f = voucherService(voucherForm('Tiền Mặt', 'Tiền Mặt Kho HN'));
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.requests[0]).toMatchObject({
        kind: 'PAYMENT_VOUCHER',
        sourceType: 'LARK_PAYMENT_VOUCHER',
        clientUuid: 'LARK:D2688DAB',
        branchId: 6,
        createdById: 9,
        status: 'APPROVED',
      });
      expect(f.requests[0].formSnapshot.metadata).toMatchObject({
        amount: 9000000,
        description: 'Mua bìa',
      });
      expect(f.fundLedger.applyPaymentVoucher).toHaveBeenCalledTimes(1);
      expect(f.events[0].approvalRequestId).toBe(50);
    });

    it('uses only the cash part of a mixed transfer-and-cash voucher', async () => {
      const f = voucherService(
        voucherForm(
          'Chuyển Khoản (Công Ty + Tiền Mặt)',
          'Tiền Mặt Kho SG',
          33088000,
        ),
      );
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.requests[0]).toMatchObject({ branchId: 1 });
      expect(f.requests[0].formSnapshot.metadata.amount).toBe(33088000);
    });

    it('ignores vouchers that do not take cash from an internal fund', async () => {
      const f = voucherService(voucherForm('Tiền Mặt', 'Không Chi Tiền Mặt'));
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.requests).toHaveLength(0);
      expect(f.fundLedger.applyPaymentVoucher).not.toHaveBeenCalled();
      expect(f.events[0].error).toContain('Đơn Lark không ghi quỹ');
    });
  });
  describe('Lark-created PHIẾU THU', () => {
    const receiptCode = '09CFDCE2-D026-44C7-A94C-8C6B02660BA1';
    // Dạng form Lark trả về: `value` là chữ, `option.key` là mã lựa chọn.
    const pick = (id: string, text: string, key: string) => ({
      id,
      type: 'radioV2',
      value: text,
      option: { key, text },
    });
    const common = (method = 'md9r0rqr-tlntv5zjg8-1') => [
      pick('widget17321728506550001', 'Tiền mặt', method),
      {
        id: 'widget17321631178550001',
        type: 'date',
        value: '2026-10-08T17:00:00Z',
      },
      { id: 'widget17321629138780001', type: 'amount', value: 270000000 },
      {
        id: 'widget17321628654580001',
        type: 'textarea',
        value: 'kho nộp tiền',
      },
    ];
    const transferForm = (to = 'msmnlsb8-5t1nguy4lg2-0', method?: string) => [
      pick(
        'widget17321740179360001',
        'Chuyển tiền nội bộ',
        'miior6p8-s0rjayqbcv-1',
      ),
      pick('widget17863314165550001', 'Kho Hà Nội', 'msmnlqej-t6tk3qikgcm-0'),
      pick('widget17863314190270001', 'Văn Phòng Hà Nội', to),
      ...common(method),
    ];
    const otherReceiptForm = [
      pick('widget17321740179360001', 'Khác', 'm3qzoq6o-9zz1b70wu0s-0'),
      pick(
        'widget17730449889490001',
        'Quỹ tiền mặt Kho Sài Gòn',
        'mmix7h92-vnvw9s8fgxd-0',
      ),
      ...common(),
    ];
    function receiptService(form: any[]) {
      const requests: any[] = [];
      const transfers: any[] = [];
      const events: any[] = [];
      const f = createService({
        approvalRequest: {
          findUnique: jest.fn(
            async ({ where }: any) =>
              requests.find(
                (row) =>
                  row.id === where.id ||
                  (where.instanceCode &&
                    row.instanceCode === where.instanceCode),
              ) || null,
          ),
          create: jest.fn(async ({ data }: any) => {
            if (requests.some((row) => row.instanceCode === data.instanceCode))
              throw Object.assign(new Error('unique'), { code: 'P2002' });
            const row = { id: 60, lastEventAt: null, ...data };
            requests.push(row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) =>
            Object.assign(
              requests.find((row) => row.id === where.id),
              data,
            ),
          ),
        },
      });
      (f.prisma.user as any).findFirst = jest.fn().mockResolvedValue({ id: 9 });
      (f.prisma as any).internalFundTransfer = {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: 4, ...data };
          transfers.push(row);
          return row;
        }),
        update: jest.fn(async ({ data }: any) =>
          Object.assign(transfers[0], data),
        ),
      };
      (f.fundLedger as any).code = jest.fn().mockReturnValue('QF-CHUYEN-test');
      f.prisma.approvalRequestEvent = {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: events.length + 1, ...data };
          events.push(row);
          return row;
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async () =>
          events.filter((row) => !row.approvalRequestId),
        ),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            events.find((row) => row.id === where.id),
            data,
          ),
        ),
        updateMany: jest.fn(),
      } as any;
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: {
          status: 'APPROVED',
          open_id: 'ou_requester',
          serial_number: '202610090006',
          form: JSON.stringify(form),
        },
      });
      return { ...f, requests, transfers, events };
    }
    const approvedEvent = {
      approval_code: receiptCode,
      instance_code: 'PT-0001',
      status: 'APPROVED',
      instance_operate_time: '1792000000000',
    };

    it('turns a warehouse-to-office cash receipt into one fund transfer posted on approval', async () => {
      const f = receiptService(transferForm());
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.transfers[0]).toMatchObject({
        clientUuid: 'LARK:PT-0001',
        sourceBranchId: 6,
        destinationBranchId: 4,
        amount: 270000000,
        description: 'kho nộp tiền',
        createdBy: 9,
        approvalRequestId: 60,
      });
      expect(f.transfers[0].occurredAt.toISOString()).toBe(
        '2026-10-08T17:00:00.000Z',
      );
      expect(f.requests[0]).toMatchObject({
        kind: 'RECEIPT',
        sourceType: 'INTERNAL_FUND_TRANSFER',
        sourceId: 4,
        branchId: 6,
        clientUuid: 'LARK:PT-0001',
        status: 'APPROVED',
      });
      // Ghi hai chiều do sổ quỹ đảm nhiệm, giống đơn chuyển tiền tạo từ POS.
      expect(f.fundLedger.applyApproval).toHaveBeenCalledTimes(1);
      expect(f.fundLedger.applyApproval.mock.calls[0][1]).toMatchObject({
        sourceType: 'INTERNAL_FUND_TRANSFER',
        status: 'APPROVED',
      });

      // Sự kiện lặp lại không tạo lệnh chuyển thứ hai.
      await f.service.handleInstanceEvent({ ...approvedEvent, uuid: 'again' });
      expect(f.transfers).toHaveLength(1);
      expect(f.requests).toHaveLength(1);
    });

    it('turns a cash "other" receipt into a fund receipt of the chosen fund', async () => {
      const f = receiptService(otherReceiptForm);
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.transfers).toHaveLength(0);
      expect(f.requests[0]).toMatchObject({
        sourceType: 'INTERNAL_FUND_RECEIPT',
        branchId: 1,
        createdById: 9,
      });
      expect(f.fundLedger.applyApproval).toHaveBeenCalledTimes(1);
    });

    it('records a bank-transfer receipt the same way: only the two places matter', async () => {
      const f = receiptService(
        transferForm('msmnlsb8-5t1nguy4lg2-0', '$i18n-m3sj1xiv-4ru39bef6i-1'),
      );
      await f.service.handleInstanceEvent(approvedEvent);
      expect(f.transfers[0]).toMatchObject({
        sourceBranchId: 6,
        destinationBranchId: 4,
        amount: 270000000,
      });
      expect(f.requests[0]).toMatchObject({
        sourceType: 'INTERNAL_FUND_TRANSFER',
        status: 'APPROVED',
      });
      expect(f.fundLedger.applyApproval).toHaveBeenCalledTimes(1);
    });

    it('ignores receipts whose places are not two different POS funds', async () => {
      const unknownPlace = receiptService(transferForm('noi-khac'));
      await unknownPlace.service.handleInstanceEvent(approvedEvent);
      const sameFund = receiptService(transferForm('msmnlsb8-4p1ddn0lzf4-0'));
      await sameFund.service.handleInstanceEvent(approvedEvent);
      for (const f of [unknownPlace, sameFund]) {
        expect(f.requests).toHaveLength(0);
        expect(f.transfers).toHaveLength(0);
        expect(f.fundLedger.applyApproval).not.toHaveBeenCalled();
        expect(f.events[0].error).toContain('Đơn Lark không ghi quỹ');
      }
    });
  });
  describe('Lark-created PHIẾU CHI KHO', () => {
    const sgCode = 'AE8660B8-4467-45FE-9878-F3B649372E8C';
    const sgForm = [
      { id: 'widget17399388386300001', type: 'input', value: '42' },
      { id: 'widget17399508904720001', type: 'input', value: '2026-10-13' },
      { id: 'widget17399508961760001', type: 'input', value: '2026-10-13' },
      { id: 'widget17368415755750001', type: 'amount', value: 150000 },
      { id: 'widget17368416610880001', type: 'input', value: 'Tiền ship' },
    ];
    function khoService(operateTime: string) {
      const requests: any[] = [];
      const events: any[] = [];
      const larkMirror = {
        ...larkMirrorStub(),
        inspect: jest.fn().mockResolvedValue({
          summary: {
            inScope: true,
            branchId: 1,
            amount: 150000,
            description: 'Tiền ship',
            skipReason: null,
          },
          suspectDuplicateOfId: null,
        }),
      };
      const f = createService({
        larkMirror,
        approvalRequest: {
          findUnique: jest.fn(
            async ({ where }: any) =>
              requests.find(
                (row) =>
                  row.id === where.id ||
                  (where.instanceCode &&
                    row.instanceCode === where.instanceCode),
              ) || null,
          ),
          create: jest.fn(async ({ data }: any) => {
            const row = { id: 60, lastEventAt: null, ...data };
            requests.push(row);
            return row;
          }),
          update: jest.fn(async ({ where, data }: any) =>
            Object.assign(
              requests.find((row) => row.id === where.id),
              data,
            ),
          ),
        },
      });
      (f.prisma.user as any).findFirst = jest.fn().mockResolvedValue({ id: 9 });
      f.prisma.approvalRequestEvent = {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: events.length + 1, ...data };
          events.push(row);
          return row;
        }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async () =>
          events.filter((row) => !row.approvalRequestId),
        ),
        update: jest.fn(async ({ where, data }: any) =>
          Object.assign(
            events.find((row) => row.id === where.id),
            data,
          ),
        ),
        updateMany: jest.fn(),
      } as any;
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: {
          status: 'APPROVED',
          open_id: 'ou_requester',
          form: JSON.stringify(sgForm),
        },
      });
      const event = {
        approval_code: sgCode,
        instance_code: 'KHO-SG-1',
        status: 'APPROVED',
        instance_operate_time: operateTime,
      };
      return { ...f, requests, events, event };
    }

    it('keeps a PHIẾU CHI KHO made on Lark for viewing only', async () => {
      const f = khoService('1792000000000');
      f.larkMirror.inspect.mockResolvedValue({
        summary: {
          inScope: false,
          fundBranchIds: [],
          skipReason: 'PHIẾU CHI KHO tạo trên Lark: chỉ xem, không ghi quỹ',
        },
        suspectDuplicateOfId: null,
      });
      await f.service.handleInstanceEvent(f.event);
      expect(f.larkMirror.save).toHaveBeenCalled();
      expect(f.requests).toHaveLength(0);
      expect(f.events[0].error).toContain('chỉ xem');
      expect(f.events[0].processedAt).toBeInstanceOf(Date);
    });

    it('does not re-run the fund step for an order POS already handled', async () => {
      const f = khoService('1792000000000');
      const voucherCode = '2A4BC15D-09F4-44FB-8B51-FD3174D5963B';
      f.requests.push({
        id: 70,
        instanceCode: 'PC-1',
        clientUuid: 'LARK:PC-1',
        sourceType: 'LARK_PAYMENT_VOUCHER',
        status: 'APPROVED',
        lastEventAt: null,
      });
      expect(await f.service.syncLarkInstance('PC-1', voucherCode)).toBe(
        'UNCHANGED',
      );
      expect(f.fundLedger.applyPaymentVoucher).not.toHaveBeenCalled();
      expect(f.larkMirror.save).toHaveBeenCalledWith(
        expect.objectContaining({ approvalRequestId: 70 }),
      );
      expect(f.larkMirror.ensureEntry).toHaveBeenCalledWith(70);
    });

    it('books the fund once when an order POS saw pending is now approved', async () => {
      const f = khoService('1792000000000');
      const voucherCode = '2A4BC15D-09F4-44FB-8B51-FD3174D5963B';
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: { status: 'APPROVED', end_time: '1792000000000', form: '[]' },
      });
      f.requests.push({
        id: 71,
        instanceCode: 'PC-2',
        clientUuid: 'LARK:PC-2',
        sourceType: 'LARK_PAYMENT_VOUCHER',
        status: 'PENDING',
        lastEventAt: null,
      });
      expect(await f.service.syncLarkInstance('PC-2', voucherCode)).toBe(
        'SYNCED',
      );
      expect(f.fundLedger.applyPaymentVoucher).toHaveBeenCalledTimes(1);
      expect(f.requests[0].status).toBe('APPROVED');
    });

    it('does not book the fund again for an order already on the Lark Base ledger', async () => {
      const f = khoService('1792000000000');
      f.larkMirror.hasLedgerTwin.mockResolvedValue(true);
      const voucherCode = '2A4BC15D-09F4-44FB-8B51-FD3174D5963B';
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: { status: 'APPROVED', end_time: '1792000000000', form: '[]' },
      });
      f.requests.push({
        id: 72,
        instanceCode: 'PC-3',
        clientUuid: 'LARK:PC-3',
        sourceType: 'LARK_PAYMENT_VOUCHER',
        branchId: 1,
        formSnapshot: { metadata: { amount: 33088000 } },
        status: 'PENDING',
        lastEventAt: null,
      });
      await f.service.syncLarkInstance('PC-3', voucherCode);
      expect(f.requests[0].status).toBe('APPROVED');
      expect(f.fundLedger.applyPaymentVoucher).not.toHaveBeenCalled();
      expect(f.larkMirror.hasLedgerTwin).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ branchId: 1, amount: 33088000 }),
      );
    });

    it('leaves office-fund vouchers to the user when backfilling', async () => {
      const f = khoService('1792000000000');
      f.larkMirror.inspect.mockResolvedValue({
        summary: { inScope: false, fundBranchIds: [4], skipReason: 'VP' },
        suspectDuplicateOfId: null,
      });
      const voucherCode = '2A4BC15D-09F4-44FB-8B51-FD3174D5963B';
      expect(
        await f.service.syncLarkInstance('VP-1', voucherCode, {
          fundBranches: [6, 1],
        }),
      ).toBe('MIRRORED');
      expect(f.requests).toHaveLength(0);
      expect(f.fundLedger.applyPaymentVoucher).not.toHaveBeenCalled();
    });

    it('does not take in a weekly approval the POS sent before its code was saved', async () => {
      const f = khoService('1792000000000');
      f.larkClient.approval.v4.instance.get.mockResolvedValue({
        code: 0,
        data: { status: 'PENDING', uuid: 'INTERNAL_FINANCE_WEEK:1:1:a:b' },
      });
      f.prisma.approvalRequest.findUnique = jest.fn(async ({ where }: any) =>
        where.clientUuid === 'INTERNAL_FINANCE_WEEK:1:1:a:b'
          ? { clientUuid: where.clientUuid }
          : null,
      );
      expect(await f.service.syncLarkInstance('KHO-SG-1', sgCode)).toBe('POS');
      expect(f.requests).toHaveLength(0);
      expect(f.larkMirror.save).not.toHaveBeenCalled();
    });
  });
});
