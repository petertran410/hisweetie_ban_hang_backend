import 'reflect-metadata';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as ExcelJS from 'exceljs';
import type { Response } from 'express';
import { PassThrough, Readable } from 'stream';
import { finished } from 'stream/promises';
import { InternalFundExportQueryDto } from './dto/internal-fund.dto';
import { InternalFundService } from './internal-fund.service';
import { fundExportColumns } from './internal-fund-export';

function fixture() {
  const prisma: any = {
    internalFundTransaction: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const access: any = {
    can: jest.fn(async (_userId: number, branchId: number) => branchId === 6),
  };
  const service = new InternalFundService(prisma, access, {} as any, {} as any);
  const stream = Object.assign(new PassThrough(), { setHeader: jest.fn() });
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const response = stream as unknown as Response;
  const readWorkbook = async () => {
    await finished(stream);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from(chunks));
    return workbook;
  };
  return { prisma, service, stream, response, readWorkbook };
}

function row(transactionType = 'RECEIPT', amount = '125000.25') {
  return {
    id: 1,
    code: 'QNB-1',
    transactionType,
    amount: new Prisma.Decimal(amount),
    occurredAt: new Date('2026-11-11T18:00:00Z'),
    description: '=SUM(A1:A2)',
    sourceType: 'LEDGER_HISTORY',
    status: 'POSTED',
    createdAt: new Date('2026-11-12T03:00:00Z'),
    cancelledAt: null,
    cancelReason: null,
    branch: { name: 'Kho Hà Nội' },
    entry: {
      code: 'TCNB-CHI-1',
      occurredAt: new Date('2026-11-10T17:00:00Z'),
      weeklyBatch: { code: 'TCT-1' },
    },
    approvalRequest: { instanceCode: 'approval-1' },
    transfer: { code: 'CQ-1' },
  };
}

describe('Internal fund filters and exports', () => {
  it.each([
    ['RECEIPT', ['RECEIPT', 'TRANSFER_IN']],
    ['EXPENSE', ['EXPENSE', 'TRANSFER_OUT']],
  ] as const)(
    'uses the same %s filters for list, totals and export',
    async (direction, types) => {
      const f = fixture();
      const query = {
        branchId: 6,
        direction,
        search: 'TCNB',
        status: 'CANCELLED',
        fromDate: '2026-11-01',
        toDate: '2026-11-12',
        orderBy: 'amount' as const,
        orderDirection: 'asc' as const,
        page: 8,
        limit: 10,
      };
      await f.service.listTransactions(query, { id: 7 });
      const listed = f.prisma.internalFundTransaction.findMany.mock.calls[0][0];
      expect(listed.where).toMatchObject({
        branchId: { in: [6] },
        status: 'CANCELLED',
        AND: [{ transactionType: { in: [...types] } }],
        occurredAt: {
          gte: new Date('2026-10-31T17:00:00Z'),
          lt: new Date('2026-11-12T17:00:00Z'),
        },
      });
      expect(listed.where.OR).toContainEqual({
        entry: { code: { contains: 'TCNB', mode: 'insensitive' } },
      });
      expect(
        f.prisma.internalFundTransaction.groupBy.mock.calls[0][0].where,
      ).toEqual(listed.where);
      expect(
        f.prisma.internalFundTransaction.count.mock.calls[0][0].where,
      ).toEqual(listed.where);

      await f.service.exportTransactions(query, { id: 7 }, f.response);
      const exported =
        f.prisma.internalFundTransaction.findMany.mock.calls[1][0];
      expect(exported.where).toEqual(listed.where);
      expect(exported.orderBy).toEqual(listed.orderBy);
      expect(exported).toMatchObject({ skip: 0, take: 500 });
      await f.readWorkbook();
    },
  );

  it('preserves the existing exact-type filter and defaults to posted rows', async () => {
    const f = fixture();
    await f.service.listTransactions(
      {
        branchId: 6,
        transactionType: 'TRANSFER_IN',
        direction: 'RECEIPT',
        page: 1,
        limit: 30,
      },
      { id: 7 },
    );
    expect(
      f.prisma.internalFundTransaction.findMany.mock.calls[0][0].where,
    ).toMatchObject({
      status: 'POSTED',
      transactionType: 'TRANSFER_IN',
      AND: [{ transactionType: { in: ['RECEIPT', 'TRANSFER_IN'] } }],
    });
  });

  it('exports all batches with numeric money, Vietnam dates, labels and totals', async () => {
    const f = fixture();
    const first = Array.from({ length: 500 }, (_, index) => ({
      ...row(index % 2 ? 'TRANSFER_OUT' : 'TRANSFER_IN', '100.25'),
      id: index + 1,
    }));
    f.prisma.internalFundTransaction.findMany
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([
        { ...row('RECEIPT', '50.5'), sourceType: 'WAREHOUSE_CASH_RECEIPT' },
      ]);
    await f.service.exportTransactions(
      { branchId: 6, page: 20, limit: 1 },
      { id: 7 },
      f.response,
    );
    expect(
      f.prisma.internalFundTransaction.findMany.mock.calls.map(([args]) => [
        args.skip,
        args.take,
      ]),
    ).toEqual([
      [0, 500],
      [500, 500],
    ]);
    const workbook = await f.readWorkbook();
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe('Sổ quỹ tổng quan');
    expect(sheet.rowCount).toBe(503);
    expect(sheet.getCell('E2').value).toEqual(new Date('2026-11-12T01:00:00Z'));
    expect(sheet.getCell('F2').value).toEqual(new Date('2026-11-11T00:00:00Z'));
    expect(sheet.getCell('G2').value).toBe('Tiền thu');
    expect(sheet.getCell('H2').value).toBe('Chuyển đến');
    expect(sheet.getCell('I2').value).toBe('=SUM(A1:A2)');
    expect(sheet.getCell('I2').type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell('J2').value).toBe(100.25);
    expect(sheet.getCell('K3').value).toBe(100.25);
    expect(sheet.getCell('H502').value).toBe('Thu tiền khách');
    expect(sheet.getCell('A503').value).toBe('Tổng');
    expect(sheet.getCell('J503').value).toBe(25113);
    expect(sheet.getCell('K503').value).toBe(25062.5);
    expect(sheet.getColumn('J').numFmt).toContain('#,##0.00');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(f.stream.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/SoQuy_TongQuan_.*\.xlsx/),
    );
  });

  it('exports only selected detail columns, including cancellation and source fields', async () => {
    const f = fixture();
    f.prisma.internalFundTransaction.findMany.mockResolvedValue([
      {
        ...row('EXPENSE'),
        status: 'CANCELLED',
        cancelledAt: new Date('2026-11-12T06:00:00Z'),
        cancelReason: 'Ghi nhầm',
      },
    ]);
    await f.service.exportTransactions(
      {
        branchId: 6,
        columns:
          'code,status,weeklyBatchCode,approvalCode,transferCode,cancelledAt,cancelReason',
        page: 1,
        limit: 30,
      },
      { id: 7 },
      f.response,
      true,
    );
    const workbook = await f.readWorkbook();
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe('Sổ quỹ chi tiết');
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'STT',
      'Mã giao dịch quỹ',
      'Trạng thái',
      'Approval tuần',
      'Mã đơn duyệt',
      'Mã chuyển quỹ',
      'Ngày hủy',
      'Lý do hủy',
    ]);
    expect(sheet.getRow(2).values).toEqual([
      undefined,
      1,
      'QNB-1',
      'Đã hủy',
      'TCT-1',
      'approval-1',
      'CQ-1',
      new Date('2026-11-12T13:00:00Z'),
      'Ghi nhầm',
    ]);
    expect(sheet.columnCount).toBe(8);
  });

  it('produces a valid empty workbook with zero totals', async () => {
    const f = fixture();
    await f.service.exportTransactions(
      { page: 1, limit: 30 },
      { id: 7 },
      f.response,
    );
    const workbook = await f.readWorkbook();
    const sheet = workbook.worksheets[0];
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell('J2').value).toBe(0);
    expect(sheet.getCell('K2').value).toBe(0);
  });

  it('rejects an inaccessible branch before starting the download', async () => {
    const f = fixture();
    await expect(
      f.service.exportTransactions(
        {
          branchId: 1,
          page: 1,
          limit: 30,
        },
        { id: 7 },
        f.response,
      ),
    ).rejects.toThrow('Không có quyền');
    expect(f.prisma.internalFundTransaction.findMany).not.toHaveBeenCalled();
    expect(f.stream.setHeader).not.toHaveBeenCalled();
    f.stream.end();
  });

  it.each(['not-a-column', ', ,', 'code,not-a-column'])(
    'rejects invalid detail columns: %s',
    (columns) => {
      expect(() => fundExportColumns(true, columns)).toThrow(
        'Cột xuất chi tiết không hợp lệ',
      );
    },
  );

  it('accepts export columns under strict DTO validation and rejects invalid directions', async () => {
    const query = plainToInstance(InternalFundExportQueryDto, {
      branchId: '6',
      direction: 'RECEIPT',
      columns: 'code,receipt',
    });
    expect(
      await validate(query, { whitelist: true, forbidNonWhitelisted: true }),
    ).toEqual([]);
    expect(query.branchId).toBe(6);
    query.direction = 'TRANSFER_IN' as any;
    expect(
      (await validate(query)).some((error) => error.property === 'direction'),
    ).toBe(true);
  });
});
