import { Prisma } from '@prisma/client';
import type {
  InternalFinanceAttachment,
  InternalFinanceInvoiceLink,
} from '@prisma/client';
import {
  ACTIVE_ROW,
  activeAttachments,
  activeInvoiceLinks,
  syncEntryAttachments,
  syncEntryInvoiceLinks,
} from './entry-files';

type IdIn = { id: { in: number[] }; removedAt?: null };

function attachment(
  id: number,
  fileUrl: string,
  extra: Partial<InternalFinanceAttachment> = {},
): InternalFinanceAttachment {
  return {
    id,
    entryId: 1,
    kind: 'EVIDENCE',
    fileUrl,
    fileName: `${id}.jpg`,
    fileType: 'image/jpeg',
    fileSize: 100,
    createdBy: 3,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    removedAt: null,
    removedBy: null,
    ...extra,
  };
}

// Kho chứng từ trong bộ nhớ: không có delete/deleteMany (xóa cứng sẽ lỗi).
function attachmentDb(rows: InternalFinanceAttachment[]) {
  let nextId = 100;
  const findMany = jest.fn(
    (args: { where: { entryId: number; removedAt: null } }) =>
      Promise.resolve(
        rows
          .filter(
            (row) =>
              row.entryId === args.where.entryId && row.removedAt === null,
          )
          .sort((a, b) => a.id - b.id),
      ),
  );
  const updateMany = jest.fn(
    (args: { where: IdIn; data: { removedAt: Date; removedBy: number } }) => {
      const hit = rows.filter(
        (row) => args.where.id.in.includes(row.id) && row.removedAt === null,
      );
      hit.forEach((row) => Object.assign(row, args.data));
      return Promise.resolve({ count: hit.length });
    },
  );
  const createMany = jest.fn(
    (args: { data: Omit<InternalFinanceAttachment, 'id' | 'createdAt'>[] }) => {
      for (const data of args.data)
        rows.push(
          attachment(nextId++, data.fileUrl, {
            ...data,
            createdAt: new Date(),
            removedAt: null,
            removedBy: null,
          }),
        );
      return Promise.resolve({ count: args.data.length });
    },
  );
  const tx = {
    internalFinanceAttachment: { findMany, updateMany, createMany },
  } as unknown as Prisma.TransactionClient;
  return { tx, findMany, updateMany, createMany, rows };
}

describe('syncEntryAttachments', () => {
  it('soft-removes missing files, adds new ones and leaves kept rows untouched', async () => {
    const rows = [
      attachment(1, 'u1'),
      attachment(2, 'u2'),
      attachment(3, 'u1', { kind: 'INVOICE' }),
      attachment(4, 'old', { removedAt: new Date('2026-09-01'), removedBy: 2 }),
    ];
    const f = attachmentDb(rows);
    const result = await syncEntryAttachments(
      f.tx,
      1,
      [
        { fileUrl: 'u1' },
        { fileUrl: 'u1', kind: 'EVIDENCE' }, // trùng → khử
        { fileUrl: 'u1', kind: 'INVOICE' },
        { fileUrl: 'u3', fileName: 'moi.pdf', fileType: 'application/pdf' },
      ],
      9,
    );

    expect(result.kept.map((row) => row.id)).toEqual([1, 3]);
    expect(result.removed).toEqual([
      expect.objectContaining({ id: 2, removedBy: 9 }),
    ]);
    expect(result.removed[0].removedAt).toBeInstanceOf(Date);
    expect(result.added).toEqual([
      expect.objectContaining({
        fileUrl: 'u3',
        kind: 'EVIDENCE',
        fileName: 'moi.pdf',
        createdBy: 9,
      }),
    ]);
    // Dòng giữ nguyên không bị ghi lại (giữ người tạo/lúc tạo).
    expect(rows.find((row) => row.id === 1)).toMatchObject({
      createdBy: 3,
      removedAt: null,
    });
    // Dòng gỡ vẫn còn, chỉ có removedAt/removedBy.
    expect(rows.find((row) => row.id === 2)).toMatchObject({ removedBy: 9 });
    expect(rows.find((row) => row.id === 4)).toMatchObject({ removedBy: 2 });
    expect(f.createMany).toHaveBeenCalledTimes(1);
    expect(f.createMany.mock.calls[0][0].data).toHaveLength(1);
    expect(f.updateMany).toHaveBeenCalledTimes(1);
    expect(f.updateMany.mock.calls[0][0].where).toEqual({
      id: { in: [2] },
      removedAt: null,
    });
  });

  it('writes nothing when the list is unchanged', async () => {
    const f = attachmentDb([attachment(1, 'u1'), attachment(2, 'u2')]);
    const result = await syncEntryAttachments(
      f.tx,
      1,
      [{ fileUrl: 'u2' }, { fileUrl: 'u1', kind: '' }],
      9,
    );
    expect(result.kept.map((row) => row.id)).toEqual([1, 2]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(f.updateMany).not.toHaveBeenCalled();
    expect(f.createMany).not.toHaveBeenCalled();
  });

  it('removes every file for an empty list and drops duplicate active rows', async () => {
    const f = attachmentDb([attachment(1, 'u1'), attachment(2, 'u1')]);
    const kept = await syncEntryAttachments(f.tx, 1, [{ fileUrl: 'u1' }], 9);
    expect(kept.kept.map((row) => row.id)).toEqual([1]);
    expect(kept.removed.map((row) => row.id)).toEqual([2]);
    const cleared = await syncEntryAttachments(f.tx, 1, [], 9);
    expect(cleared.removed.map((row) => row.id)).toEqual([1]);
    expect(f.rows.every((row) => row.removedAt !== null)).toBe(true);
  });
});

function link(
  id: number,
  invoiceId: number,
  extra: Partial<InternalFinanceInvoiceLink> = {},
): InternalFinanceInvoiceLink {
  return {
    id,
    entryId: 1,
    invoiceId,
    amount: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    removedAt: null,
    removedBy: null,
    ...extra,
  };
}

function invoiceLinkDb(rows: InternalFinanceInvoiceLink[]) {
  let nextId = 100;
  const findMany = jest.fn((args: { where: { entryId: number } }) =>
    Promise.resolve(
      rows
        .filter((row) => row.entryId === args.where.entryId)
        .sort((a, b) => a.id - b.id),
    ),
  );
  const updateMany = jest.fn(
    (args: { where: IdIn; data: { removedAt: Date; removedBy: number } }) => {
      const hit = rows.filter(
        (row) => args.where.id.in.includes(row.id) && row.removedAt === null,
      );
      hit.forEach((row) => Object.assign(row, args.data));
      return Promise.resolve({ count: hit.length });
    },
  );
  const update = jest.fn(
    (args: {
      where: { id: number };
      data: Partial<InternalFinanceInvoiceLink>;
    }) => {
      const row = rows.find((item) => item.id === args.where.id)!;
      return Promise.resolve(Object.assign(row, args.data));
    },
  );
  const create = jest.fn(
    (args: {
      data: {
        entryId: number;
        invoiceId: number;
        amount: Prisma.Decimal | null;
      };
    }) => {
      if (
        rows.some(
          (row) =>
            row.entryId === args.data.entryId &&
            row.invoiceId === args.data.invoiceId,
        )
      )
        return Promise.reject(new Error('Unique constraint entryId_invoiceId'));
      const row = link(nextId++, args.data.invoiceId, args.data);
      rows.push(row);
      return Promise.resolve(row);
    },
  );
  const tx = {
    internalFinanceInvoiceLink: { findMany, updateMany, update, create },
  } as unknown as Prisma.TransactionClient;
  return { tx, findMany, updateMany, update, create, rows };
}

describe('syncEntryInvoiceLinks', () => {
  it('removes, revives and adds links without breaking the unique key', async () => {
    const rows = [
      link(1, 10),
      link(2, 11),
      link(3, 12, { removedAt: new Date('2026-09-01'), removedBy: 2 }),
    ];
    const f = invoiceLinkDb(rows);
    const result = await syncEntryInvoiceLinks(
      f.tx,
      1,
      [{ invoiceId: 10 }, { invoiceId: 12, amount: 5000 }, { invoiceId: 13 }],
      9,
    );
    expect(result.kept.map((row) => row.id)).toEqual([1]);
    expect(result.removed.map((row) => [row.id, row.removedBy])).toEqual([
      [2, 9],
    ]);
    expect(result.revived).toEqual([
      expect.objectContaining({ id: 3, removedAt: null, removedBy: null }),
    ]);
    expect(result.revived[0].amount?.toString()).toBe('5000');
    expect(result.added.map((row) => row.invoiceId)).toEqual([13]);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(rows.find((row) => row.id === 2)?.removedAt).toBeInstanceOf(Date);
  });

  it('updates the amount of a kept link only when given and different', async () => {
    const f = invoiceLinkDb([
      link(1, 10, { amount: new Prisma.Decimal(100) }),
      link(2, 11, { amount: new Prisma.Decimal(200) }),
    ]);
    const result = await syncEntryInvoiceLinks(
      f.tx,
      1,
      [
        { invoiceId: 10, amount: 100 },
        { invoiceId: 11, amount: 250 },
      ],
      9,
    );
    expect(result.kept.map((row) => row.amount?.toString())).toEqual([
      '100',
      '250',
    ]);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});

describe('active row filters', () => {
  it('filters removed rows in includes', () => {
    expect(ACTIVE_ROW).toEqual({ removedAt: null });
    expect(activeAttachments).toEqual({
      where: { removedAt: null },
      orderBy: { id: 'asc' },
    });
    expect(activeInvoiceLinks()).toEqual({ where: { removedAt: null } });
    expect(
      activeInvoiceLinks({
        include: { invoice: { select: { id: true, code: true } } },
      }),
    ).toEqual({
      include: { invoice: { select: { id: true, code: true } } },
      where: { removedAt: null },
    });
    expect(activeInvoiceLinks({ where: { invoiceId: 5 } })).toEqual({
      where: { invoiceId: 5, removedAt: null },
    });
  });

  // Chỉ kiểm tra kiểu khi biên dịch (không chạy): helper dùng được trong include.
  it('type-checks inside a Prisma include', () => {
    const typed = (tx: Prisma.TransactionClient) =>
      tx.internalFinanceEntry
        .findUnique({
          where: { id: 1 },
          include: {
            attachments: activeAttachments,
            invoiceLinks: activeInvoiceLinks({
              include: { invoice: { select: { id: true, code: true } } },
            }),
          },
        })
        .then((entry) => [
          entry?.attachments[0]?.fileUrl,
          entry?.invoiceLinks[0]?.invoice.code,
        ]);
    expect(typeof typed).toBe('function');
  });
});
