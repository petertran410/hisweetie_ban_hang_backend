import { NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PublicApiClientAdminService } from './public-api-client-admin.service';

describe('PublicApiClientAdminService', () => {
  const client = {
    id: 'client-1',
    name: 'Zalo CRM',
    description: null,
    clientId: 'hpa_existing',
    isActive: true,
    accessTokenTtl: 3600,
    createdAt: new Date('2026-08-15T00:00:00.000Z'),
    updatedAt: new Date('2026-08-15T00:00:00.000Z'),
  };

  const createService = () => {
    const prisma: any = {
      publicApiClient: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      publicApiWebhook: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    return { prisma, service: new PublicApiClientAdminService(prisma) };
  };

  it('list không trả clientSecret hash', async () => {
    const { service, prisma } = createService();
    prisma.publicApiClient.findMany.mockResolvedValue([client]);

    const result = await service.findAll();

    expect(result.data[0]).not.toHaveProperty('clientSecret');
    expect(prisma.publicApiClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ clientSecret: true }),
      }),
    );
  });

  it('tạo secret ngẫu nhiên, chỉ trả raw secret trong phản hồi tạo', async () => {
    const { service, prisma } = createService();
    prisma.publicApiClient.create.mockImplementation(async ({ data }: any) => ({
      ...client,
      name: data.name,
      clientId: data.clientId,
    }));

    const result = await service.create({ name: 'Website' });

    expect(result.data.clientSecret).toBeTruthy();
    expect(result.data.clientId).toMatch(/^hpa_/);
    const createData = prisma.publicApiClient.create.mock.calls[0][0].data;
    expect(createData.clientSecret).not.toBe(result.data.clientSecret);
    await expect(
      bcrypt.compare(result.data.clientSecret, createData.clientSecret),
    ).resolves.toBe(true);
  });

  it('rotate sinh secret mới và chỉ trả nó trong phản hồi rotate', async () => {
    const { service, prisma } = createService();
    prisma.publicApiClient.findUnique.mockResolvedValue({ id: 'client-1' });
    prisma.publicApiClient.update.mockResolvedValue(client);

    const result = await service.rotateSecret('client-1');

    expect(result.data.clientSecret).toBeTruthy();
    const updateData = prisma.publicApiClient.update.mock.calls[0][0].data;
    expect(updateData.clientSecret).not.toBe(result.data.clientSecret);
    await expect(
      bcrypt.compare(result.data.clientSecret, updateData.clientSecret),
    ).resolves.toBe(true);
  });

  it('chỉ tắt/bật, không có delete', async () => {
    const { service, prisma } = createService();
    prisma.publicApiClient.findUnique.mockResolvedValue({ id: 'client-1' });
    prisma.publicApiClient.update.mockResolvedValue({
      ...client,
      isActive: false,
    });

    const result = await service.setActive('client-1', false);

    expect(result.data.isActive).toBe(false);
    expect(prisma.publicApiClient.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false } }),
    );
    expect(prisma.publicApiClient).not.toHaveProperty('delete');
  });

  it('trả 404 khi thao tác client không tồn tại', async () => {
    const { service, prisma } = createService();
    prisma.publicApiClient.findUnique.mockResolvedValue(null);

    await expect(service.setActive('missing', true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.publicApiClient.update).not.toHaveBeenCalled();
  });
});
