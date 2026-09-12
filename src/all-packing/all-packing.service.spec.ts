import { Test, TestingModule } from '@nestjs/testing';
import { AllPackingService } from './all-packing.service';
import { PrismaService } from '../prisma/prisma.service';

describe('AllPackingService', () => {
  let service: AllPackingService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      packingSlip: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      packingHang: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
      packingLoading: {
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AllPackingService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AllPackingService>(AllPackingService);
  });

  it('paginates single type giao-hang directly in db', async () => {
    const mockSlips = [
      {
        id: 1,
        code: 'PS001',
        createdAt: new Date('2026-09-12T10:00:00Z'),
        _count: { images: 2, expenseFiles: 1 },
      },
    ];
    prisma.packingSlip.findMany.mockResolvedValue(mockSlips);
    prisma.packingSlip.count.mockResolvedValue(10);

    const res = await service.findAll({
      type: 'giao-hang',
      pageSize: 15,
      currentItem: 0,
    });

    expect(prisma.packingSlip.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 15,
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(prisma.packingSlip.count).toHaveBeenCalled();
    expect(res.total).toBe(10);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].type).toBe('giao-hang');
    expect(res.data[0].imageCount).toBe(2);
    expect(res.data[0].expenseFileCount).toBe(1);
    expect(res.data[0].images).toHaveLength(2);
    expect(res.data[0].expenseFiles).toHaveLength(1);
  });

  it('combines keys and paginates across 3 tables when type is all', async () => {
    prisma.packingSlip.count.mockResolvedValue(2);
    prisma.packingHang.count.mockResolvedValue(1);
    prisma.packingLoading.count.mockResolvedValue(1);

    prisma.packingSlip.findMany
      .mockResolvedValueOnce([
        { id: 10, createdAt: new Date('2026-09-12T12:00:00Z') },
        { id: 11, createdAt: new Date('2026-09-12T09:00:00Z') },
      ])
      .mockResolvedValueOnce([
        {
          id: 10,
          code: 'PS010',
          createdAt: new Date('2026-09-12T12:00:00Z'),
          _count: { images: 0, expenseFiles: 0 },
        },
      ]);

    prisma.packingHang.findMany
      .mockResolvedValueOnce([
        { id: 20, createdAt: new Date('2026-09-12T11:00:00Z') },
      ])
      .mockResolvedValueOnce([
        {
          id: 20,
          code: 'PH020',
          createdAt: new Date('2026-09-12T11:00:00Z'),
          _count: { images: 1 },
        },
      ]);

    prisma.packingLoading.findMany.mockResolvedValueOnce([
      { id: 30, createdAt: new Date('2026-09-12T08:00:00Z') },
    ]);

    const res = await service.findAll({
      type: 'all',
      pageSize: 2,
      currentItem: 0,
    });

    expect(res.total).toBe(4);
    expect(res.data).toHaveLength(2);
    expect(res.data[0].id).toBe(10);
    expect(res.data[0].type).toBe('giao-hang');
    expect(res.data[1].id).toBe(20);
    expect(res.data[1].type).toBe('dong-hang');
    expect(prisma.packingLoading.findMany).toHaveBeenCalledTimes(1);
  });
});
