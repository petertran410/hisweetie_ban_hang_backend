import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as fs from 'fs';
import { QuickRepliesService } from './quick-replies.service';

const ME = { id: 7, name: 'Sale A', canManageShared: false };
const ADMIN = { id: 1, name: 'Quản lý', canManageShared: true };

const makeService = (rows: any[] = []) => {
  const store = rows.map((r) => ({ updatedAt: new Date(), ...r }));
  const prisma = {
    chatQuickReply: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(store.filter((r) => where.OR.some((c: any) => c.ownerId === r.ownerId))),
      ),
      findUnique: jest.fn(({ where }) => Promise.resolve(store.find((r) => r.id === where.id) ?? null)),
      create: jest.fn(({ data }) => Promise.resolve({ id: 99, ...data })),
      update: jest.fn(({ where, data }) => Promise.resolve({ ...store.find((r) => r.id === where.id), ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
  const audit = { create: jest.fn().mockResolvedValue({}) };
  const uploads = { getFileUrl: (p: string) => `http://pos/uploads/${p}` };
  return { service: new QuickRepliesService(prisma as any, audit as any, uploads as any), prisma, audit };
};

describe('QuickRepliesService', () => {
  const rows = [
    { id: 1, ownerId: null, shortcut: 'chao', content: 'Dạ em chào anh/chị' },
    { id: 2, ownerId: 7, shortcut: 'stk', content: 'STK của em' },
    { id: 3, ownerId: 8, shortcut: 'rieng', content: 'Tin riêng người khác' },
  ];

  it('list: tin chung + tin riêng của mình, không thấy tin riêng người khác', async () => {
    const { service } = makeService(rows);
    const res = await service.list(ME);
    expect(res.shared.map((r) => r.id)).toEqual([1]);
    expect(res.mine.map((r) => r.id)).toEqual([2]);
    expect(res.canManageShared).toBe(false);
  });

  it('create: tin riêng ai cũng tạo được; tin chung cần quyền; chuẩn hoá mã gõ tắt', async () => {
    const { service, prisma, audit } = makeService();
    await expect(service.create(ME, { shared: true, shortcut: 'x', content: 'y' })).rejects.toBeInstanceOf(ForbiddenException);
    const mine = await service.create(ME, { shortcut: ' #bao gia ', content: ' Báo giá ' });
    expect(prisma.chatQuickReply.create.mock.calls[0][0].data).toEqual({
      shortcut: 'bao-gia',
      content: 'Báo giá',
      media: Prisma.DbNull,
      ownerId: 7,
      createdById: 7,
    });
    expect(mine.ownerId).toBe(7);
    await service.create(ADMIN, { shared: true, shortcut: 'chao', content: 'Chào' });
    expect(prisma.chatQuickReply.create.mock.calls[1][0].data.ownerId).toBeNull();
    expect(audit.create).toHaveBeenCalledWith(expect.objectContaining({ actionCode: 'SMAX_QUICK_REPLY_CREATE', entityType: 'chat_quick_replies' }));
    await expect(service.create(ME, { shortcut: '  ', content: 'a' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update/remove: chủ sửa tin riêng; tin chung cần quyền; tin riêng người khác → 404', async () => {
    const { service, prisma } = makeService(rows);
    await expect(service.update(ME, 2, { shortcut: 'stk', content: 'STK mới' })).resolves.toMatchObject({ content: 'STK mới' });
    await expect(service.update(ME, 1, { shortcut: 'chao', content: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(ME, 3)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.remove(ADMIN, 3)).rejects.toBeInstanceOf(NotFoundException);
    await service.remove(ADMIN, 1);
    expect(prisma.chatQuickReply.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('media: chỉ nhận tệp đã tải lên POS (uploads/smax-chat), cho phép tin chỉ có media; trả URL xem trước', async () => {
    const { service, prisma } = makeService();
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const img = { path: 'smax-chat/1794-ab.jpg', kind: 'image' as const, name: 'catalogue.jpg', size: 10 };
    const row = await service.create(ME, { shortcut: 'catalogue', content: '', media: [img] });
    expect(prisma.chatQuickReply.create.mock.calls[0][0].data.media).toEqual([img]);
    expect(row.media).toEqual([{ ...img, url: 'http://pos/uploads/smax-chat/1794-ab.jpg' }]);
    await expect(
      service.create(ME, { shortcut: 'x', content: 'a', media: [{ ...img, path: 'https://evil.example/a.jpg' }] }),
    ).rejects.toThrow('không hợp lệ');
    exists.mockReturnValue(false);
    await expect(service.create(ME, { shortcut: 'x', content: 'a', media: [img] })).rejects.toThrow('không còn trên máy chủ');
    await expect(service.create(ME, { shortcut: 'x', content: ' ' })).rejects.toThrow('Nhập nội dung hoặc thêm ảnh/tệp');
    exists.mockRestore();
  });
});
