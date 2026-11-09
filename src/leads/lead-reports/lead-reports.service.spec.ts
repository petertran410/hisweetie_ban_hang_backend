import { PrismaService } from '../../prisma/prisma.service';
import { LeadReportsService } from './lead-reports.service';

type Args = { by?: string[]; where?: unknown };
type Mock = jest.Mock<Promise<unknown>, [Args]>;

/** Prisma giả: trả rỗng, riêng groupBy theo trạng thái trả vài số để ráp KPI. */
function makePrisma() {
  const mock = (result: (args: Args) => unknown): Mock =>
    jest.fn((args: Args) => Promise.resolve(result(args)));
  const empty = () => mock(() => []);
  const prisma = {
    lead: {
      groupBy: mock((args) =>
        args.by?.[0] === 'status'
          ? [
              { status: 'new', _count: { _all: 2 } },
              { status: 'converted', _count: { _all: 1 } },
              { status: 'cancelled', _count: { _all: 1 } },
            ]
          : [],
      ),
      count: mock(() => 0),
      findMany: empty(),
    },
    leadHandover: { groupBy: empty(), findMany: empty() },
    auditLog: { groupBy: empty() },
    user: { findMany: empty() },
  };
  const svc = new LeadReportsService(prisma as unknown as PrismaService);
  return { prisma, svc };
}

const wheresOf = (m: Mock) => m.mock.calls.map((c) => c[0].where);

/** Mọi điều kiện con (đệ quy qua AND / OR / quan hệ lead) của một where. */
function flatten(w: unknown, out: Record<string, unknown>[] = []) {
  if (!w || typeof w !== 'object') return out;
  const o = w as Record<string, unknown>;
  out.push(o);
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) v.forEach((x) => flatten(x, out));
    else if (v && typeof v === 'object') flatten(v, out);
  }
  return out;
}

const NOW = new Date('2026-11-07T03:00:00Z');
const OCT = {
  from: '2026-09-30T17:00:00.000Z', // 01/10/2026 00:00 giờ VN
  to: '2026-10-31T16:59:59.000Z', // 31/10/2026 23:59:59 giờ VN
};

describe('LeadReportsService.summary', () => {
  it('Sale (ownOnly): mọi truy vấn lead đều giới hạn salePicId = chính mình', async () => {
    const { prisma, svc } = makePrisma();
    await svc.summary(OCT, { id: 9, ownOnly: true }, NOW);

    const leadWheres = [
      ...wheresOf(prisma.lead.groupBy),
      ...wheresOf(prisma.lead.count),
      ...wheresOf(prisma.lead.findMany),
    ].filter((w) => !(w && typeof w === 'object' && 'id' in w)); // bỏ truy vấn tra theo id đã lọc sẵn
    expect(leadWheres.length).toBeGreaterThan(10);
    for (const w of leadWheres) {
      expect(flatten(w)).toContainEqual({ salePicId: 9 });
    }
    // Truy vấn chuyển giao lọc qua quan hệ lead cũng phải giữ điều kiện đó
    for (const w of [
      ...wheresOf(prisma.leadHandover.groupBy),
      ...wheresOf(prisma.leadHandover.findMany),
    ]) {
      expect(flatten(w)).toContainEqual({ salePicId: 9 });
    }
  });

  it('CSKH (leads:update): không giới hạn theo Sale PIC', async () => {
    const { prisma, svc } = makePrisma();
    await svc.summary(OCT, { id: 1, ownOnly: false }, NOW);
    const all = wheresOf(prisma.lead.count).flatMap((w) => flatten(w));
    expect(all).not.toContainEqual({ salePicId: 1 });
  });

  it('ráp KPI từ số đếm, kỳ trước = tháng trước, tỷ lệ loại huỷ', async () => {
    const { prisma, svc } = makePrisma();
    const res = await svc.summary(
      { ...OCT, sources: 'facebook,tiktok' },
      { id: 1, ownOnly: false },
      NOW,
    );
    expect(res.period).toMatchObject({
      label: 'Tháng 10/2026',
      compareLabel: 'Tháng 9/2026',
    });
    expect(res.kpis.total.value).toBe(4);
    expect(res.kpis.conversionRate.value).toBe(33.3); // 1 / (4 − 1)
    expect(res.trend.day).toHaveLength(31);
    // Bộ lọc nguồn được tách CSV giống GET /leads
    const sourceFilters = wheresOf(prisma.lead.count)
      .flatMap((w) => flatten(w))
      .filter((x) => 'source' in x);
    expect(sourceFilters[0]).toEqual({
      source: { in: ['facebook', 'tiktok'] },
    });
  });

  it('Toàn thời gian: không có kỳ trước', async () => {
    const { svc } = makePrisma();
    const res = await svc.summary({}, { id: 1, ownOnly: false }, NOW);
    expect(res.period).toMatchObject({
      from: null,
      label: 'Toàn thời gian',
      compareLabel: null,
    });
    expect(res.kpis.total.changePct).toBeNull();
  });
});
