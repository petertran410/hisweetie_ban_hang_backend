import { BadRequestException } from '@nestjs/common';
import { LarkCustomerNotificationService } from './lark-customer-notification.service';

describe('LarkCustomerNotificationService', () => {
  const customer = {
    code: 'KH000123',
    name: 'Cửa hàng An',
    organization: 'Công ty TNHH An',
    contactNumber: '0901234567',
    phone: null,
    taxCode: '0312345678',
    branch: { name: 'Chi nhánh HCM' },
  };

  const build = (opts: {
    taxCodeUserIds?: number[];
    newCustomerUserIds?: number[];
    dueDays?: number;
    users?: { id: number; name: string; larkUserId: string }[];
    messageCreate?: jest.Mock;
    taskCreate?: jest.Mock;
  }) => {
    const messageCreate =
      opts.messageCreate ?? jest.fn().mockResolvedValue({ code: 0 });
    const taskCreate =
      opts.taskCreate ?? jest.fn().mockResolvedValue({ code: 0 });
    const userFindMany = jest.fn().mockResolvedValue(opts.users ?? []);
    const prisma = {
      settings: {
        findFirst: jest.fn().mockResolvedValue({
          larkTaxCodeNotifyUserIds: opts.taxCodeUserIds ?? [],
          larkNewCustomerTaskUserIds: opts.newCustomerUserIds ?? [],
          larkNewCustomerTaskDueDays: opts.dueDays ?? 1,
        }),
      },
      user: {
        findMany: userFindMany,
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'Bình', email: 'b@x.vn' }),
      },
      customer: { findUnique: jest.fn().mockResolvedValue(customer) },
    };
    const service = new LarkCustomerNotificationService(
      {
        im: { message: { create: messageCreate } },
        task: { v2: { task: { create: taskCreate } } },
      } as any,
      prisma as any,
      { get: () => 'https://pos.example.com/' } as any,
    );
    return { service, messageCreate, taskCreate, userFindMany };
  };

  const users = [
    { id: 1, name: 'An', larkUserId: 'ou_a' },
    { id: 2, name: 'Chi', larkUserId: 'ou_c' },
  ];

  describe('notifyTaxCodeChanged', () => {
    it('gửi card riêng tới open_id của từng người, kèm MST cũ → mới và link KH', async () => {
      const { service, messageCreate } = build({
        taxCodeUserIds: [1, 2],
        users,
      });

      const result = await service.notifyTaxCodeChanged({
        customerId: 10,
        oldTaxCode: '0300000000',
        newTaxCode: '0312345678',
        actorUserId: 5,
      });

      expect(result).toEqual({ sent: ['An', 'Chi'], failed: [] });
      expect(messageCreate).toHaveBeenCalledTimes(2);
      const call = messageCreate.mock.calls[0][0];
      expect(call.params).toEqual({ receive_id_type: 'open_id' });
      expect(call.data).toMatchObject({
        receive_id: 'ou_a',
        msg_type: 'interactive',
      });
      expect(messageCreate.mock.calls[1][0].data.receive_id).toBe('ou_c');
      const card = call.data.content as string;
      expect(card).toContain('0300000000 → **0312345678**');
      expect(card).toContain(
        'https://pos.example.com/khach-hang?Code=KH000123',
      );
      expect(card).toContain('Bình');
    });

    it('không gọi Lark khi chưa chọn người nhận', async () => {
      const { service, messageCreate, userFindMany } = build({});

      const result = await service.notifyTaxCodeChanged({
        customerId: 10,
        oldTaxCode: null,
        newTaxCode: '0312345678',
      });

      expect(result).toEqual({ sent: [], failed: [] });
      expect(userFindMany).not.toHaveBeenCalled();
      expect(messageCreate).not.toHaveBeenCalled();
    });

    it('một người lỗi không chặn người còn lại', async () => {
      const messageCreate = jest
        .fn()
        .mockResolvedValueOnce({ code: 230013, msg: 'bot not available' })
        .mockResolvedValueOnce({ code: 0 });
      const { service } = build({
        taxCodeUserIds: [1, 2],
        users,
        messageCreate,
      });

      const result = await service.notifyTaxCodeChanged({
        customerId: 10,
        oldTaxCode: '0300000000',
        newTaxCode: null,
      });

      expect(result.sent).toEqual(['Chi']);
      expect(result.failed).toEqual([
        { name: 'An', error: 'Lark 230013: bot not available' },
      ]);
    });
  });

  describe('createNewCustomerTask', () => {
    it('tạo 1 task giao cho tất cả người được chọn, hạn = lúc tạo + N ngày', async () => {
      const { service, taskCreate } = build({
        newCustomerUserIds: [1, 2],
        dueDays: 2,
        users,
      });
      const before = Date.now();

      const result = await service.createNewCustomerTask(10, 5);

      expect(result).toEqual({ sent: ['An', 'Chi'], failed: [] });
      expect(taskCreate).toHaveBeenCalledTimes(1);
      const { params, data } = taskCreate.mock.calls[0][0];
      expect(params).toEqual({ user_id_type: 'open_id' });
      expect(data.summary).toBe('Khách hàng mới: Cửa hàng An (KH000123)');
      expect(data.members).toEqual([
        { id: 'ou_a', type: 'user', role: 'assignee' },
        { id: 'ou_c', type: 'user', role: 'assignee' },
      ]);
      const due = Number(data.due.timestamp);
      expect(due).toBeGreaterThanOrEqual(before + 2 * 86_400_000);
      expect(due).toBeLessThanOrEqual(Date.now() + 2 * 86_400_000);
      expect(data.client_token).toMatch(/^pos-customer-10-\d+$/);
      expect(data.origin.href.url).toBe(
        'https://pos.example.com/khach-hang?Code=KH000123',
      );
      expect(data.description).toContain('Mã số thuế: 0312345678');
      expect(data.description).toContain('Người tạo: Bình');
    });

    it('không tạo task khi chưa chọn ai', async () => {
      const { service, taskCreate } = build({});

      await service.createNewCustomerTask(10);

      expect(taskCreate).not.toHaveBeenCalled();
    });

    it('ném lỗi khi Lark trả code ≠ 0 (để log ở bản Async)', async () => {
      const taskCreate = jest
        .fn()
        .mockResolvedValue({ code: 99991672, msg: 'Access denied' });
      const { service } = build({ newCustomerUserIds: [1], users, taskCreate });

      await expect(service.createNewCustomerTask(10)).rejects.toThrow(
        'Lark 99991672: Access denied',
      );
    });
  });

  describe('sendTest', () => {
    it('báo lỗi khi chưa có người nhận', async () => {
      const { service } = build({});
      await expect(service.sendTest('taxCode')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('task thử lỗi → trả failed cho từng người thay vì ném', async () => {
      const taskCreate = jest
        .fn()
        .mockResolvedValue({ code: 99991672, msg: 'Access denied' });
      const { service } = build({
        newCustomerUserIds: [1, 2],
        users,
        taskCreate,
      });

      const result = await service.sendTest('newCustomerTask');

      expect(result.sent).toEqual([]);
      expect(result.failed.map((f) => f.name)).toEqual(['An', 'Chi']);
      expect(taskCreate.mock.calls[0][0].data.summary).toMatch(/^\[Thử\] /);
    });
  });
});
