import { ConflictException } from '@nestjs/common';
import { PublicApiIdempotencyService } from './public-api-idempotency.service';

describe('PublicApiIdempotencyService', () => {
  const clientId = 'client-uuid';

  const createService = () => {
    const prisma: any = {
      publicApiIdempotencyKey: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    return { prisma, service: new PublicApiIdempotencyService(prisma) };
  };

  const options = (key?: string, body: unknown = { name: 'Khách A' }) => ({
    clientId, key, method: 'POST', path: '/customers', body,
  });

  it('chạy thẳng khi client không gửi Idempotency-Key', async () => {
    const { service, prisma } = createService();
    const operation = jest.fn().mockResolvedValue({ data: { id: 1 } });

    await service.run(options(undefined), operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(prisma.publicApiIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it('chỉ chạy nghiệp vụ một lần và lưu lại phản hồi', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue(null);
    const operation = jest.fn().mockResolvedValue({ data: { id: 7 } });

    const result = await service.run(options('key-1'), operation);

    expect(result).toEqual({ data: { id: 7 } });
    expect(prisma.publicApiIdempotencyKey.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
  });

  it('trả lại phản hồi cũ mà không chạy lại nghiệp vụ', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue({
      status: 'COMPLETED',
      // Băm của đúng body trong `options()`; phải khớp thì mới được replay.
      requestHash: require('crypto').createHash('sha256')
        .update(JSON.stringify({ name: 'Khách A' })).digest('hex'),
      response: { data: { id: 7 } },
    });
    const operation = jest.fn();

    const result = await service.run(options('key-1'), operation);

    // Đây chính là mục đích: client timeout rồi gọi lại không tạo bản ghi thứ hai.
    expect(operation).not.toHaveBeenCalled();
    expect(result).toEqual({ data: { id: 7 } });
  });

  it('từ chối khi dùng lại khoá cho một request khác', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue({
      status: 'COMPLETED', requestHash: 'ma-bam-khac', response: { data: { id: 7 } },
    });
    const operation = jest.fn();

    // Trả phản hồi của khách A cho request tạo khách B là sai lệch dữ liệu.
    await expect(service.run(options('key-1'), operation)).rejects.toBeInstanceOf(ConflictException);
    expect(operation).not.toHaveBeenCalled();
  });

  it('chặn lần gọi thứ hai khi lần đầu còn đang chạy', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue({
      status: 'PROCESSING',
      requestHash: require('crypto').createHash('sha256')
        .update(JSON.stringify({ name: 'Khách A' })).digest('hex'),
    });
    const operation = jest.fn();

    await expect(service.run(options('key-1'), operation)).rejects.toBeInstanceOf(ConflictException);
    expect(operation).not.toHaveBeenCalled();
  });

  it('dựa vào ràng buộc unique khi hai request chạm nhau đúng lúc', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue(null);
    prisma.publicApiIdempotencyKey.create.mockRejectedValue(new Error('unique constraint'));
    const operation = jest.fn();

    await expect(service.run(options('key-1'), operation)).rejects.toBeInstanceOf(ConflictException);
    expect(operation).not.toHaveBeenCalled();
  });

  it('xoá khoá khi nghiệp vụ lỗi để client sửa dữ liệu rồi gửi lại', async () => {
    const { service, prisma } = createService();
    prisma.publicApiIdempotencyKey.findUnique.mockResolvedValue(null);
    const operation = jest.fn().mockRejectedValue(new Error('thiếu địa chỉ'));

    await expect(service.run(options('key-1'), operation)).rejects.toThrow('thiếu địa chỉ');

    // Giữ khoá lại sẽ khoá cứng client khỏi thao tác hợp lệ về sau.
    expect(prisma.publicApiIdempotencyKey.delete).toHaveBeenCalled();
  });
});
