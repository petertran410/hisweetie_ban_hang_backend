// prisma/scripts/backfill-lead-links.ts
//
// Lead đã chuyển giao trước khi có "Hành trình khách": hội thoại Zalo của Sale với khách
// chưa được lưu làm kênh kết nối, nên lead không tự gắn được với khách Sale tạo (SĐT khác,
// cùng ID Zalo — vd LEAD000021 ↔ KH052105). Script:
//   1. thêm kênh kết nối từ lần chuyển giao thành công (kênh của Sale + ID Zalo đã tra);
//   2. tự gắn lead chưa gắn (ID Zalo → hội thoại → SĐT, chỉ khi khớp đúng 1 khách);
//   3. lead đã gắn có đơn đặt hàng đầu (không huỷ) → "Đã chuyển đổi".
// Chạy SAU `prisma db push` (cột link_method / linked_at / linked_by_id).
//
// Cách chạy:
//   yarn backfill:lead-links              # chạy thử, không ghi
//   yarn backfill:lead-links --apply      # ghi thật

import 'dotenv/config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuditLogsService } from '../../src/audit-logs/audit-logs.service';
import { LeadLinkService, UNLINKED } from '../../src/leads/lead-link/lead-link.service';
import { leadCode } from '../../src/leads/leads.constants';
import { ORDER_STATUS } from '../../src/orders/dto/order-status.constants';

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  const link = new LeadLinkService(prisma, new AuditLogsService(prisma));

  try {
    // 1. Kênh kết nối từ lần chuyển giao thành công
    const handedOver = await prisma.lead.findMany({
      where: { zaloUid: { not: null }, handovers: { some: { status: 'done' } } },
      select: {
        id: true,
        name: true,
        zaloUid: true,
        createdById: true,
        conversations: { select: { tid: true } },
        handovers: {
          where: { status: 'done' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { pagePid: true, createdById: true },
        },
      },
    });
    const missing = handedOver.filter((l) => !l.conversations.some((c) => c.tid === `zlw${l.zaloUid}`));
    console.log(`Kênh kết nối thiếu: ${missing.length}/${handedOver.length} lead đã chuyển giao`);
    for (const l of missing) {
      const h = l.handovers[0];
      console.log(`  ${leadCode(l.id)} ${l.name} ← ${h.pagePid} / zlw${l.zaloUid}`);
      if (apply) {
        await prisma.leadConversation.create({
          data: {
            leadId: l.id,
            pagePid: h.pagePid,
            tid: `zlw${l.zaloUid}`,
            platform: 'zaloweb',
            isGroup: false,
            name: l.name,
            createdById: h.createdById,
          },
        });
      }
    }

    // 2. Tự gắn lead chưa gắn (chạy thử: tính bằng dữ liệu hiện có + kênh sẽ thêm ở bước 1)
    const unlinked = await prisma.lead.findMany({
      where: {
        customerId: null,
        status: { not: 'cancelled' },
        OR: [{ linkMethod: null }, { linkMethod: { not: UNLINKED } }],
      },
      select: {
        id: true,
        name: true,
        zaloUid: true,
        phoneNormalized: true,
        zaloPhone: true,
        conversations: { select: { tid: true, pagePid: true, isGroup: true } },
      },
      orderBy: { id: 'asc' },
    });
    let linked = 0;
    console.log(`\nLead chưa gắn khách: ${unlinked.length}`);
    for (const l of unlinked) {
      const hit = (await link.candidates(l)).find((c) => c.auto);
      if (!hit) continue;
      linked++;
      const order = await prisma.order.findFirst({
        where: { customerId: hit.id, status: { not: ORDER_STATUS.CANCELLED } },
        orderBy: { createdAt: 'asc' },
        select: { code: true },
      });
      console.log(
        `  ${leadCode(l.id)} ${l.name} → ${hit.code ?? hit.id} ${hit.name} (${hit.reason})` +
          (order ? ` · chuyển đổi: đơn đầu ${order.code}` : ' · chưa có đơn'),
      );
      if (apply) await link.autoLink(l.id);
    }

    // 3. Lead đã gắn từ trước, có đơn đầu → chuyển đổi
    const pending = await prisma.lead.findMany({
      where: { customerId: { not: null }, status: { notIn: ['converted', 'cancelled'] } },
      select: { id: true, name: true },
    });
    console.log(`\nLead đã gắn chưa chuyển đổi: ${pending.length}`);
    let converted = 0;
    if (apply) for (const l of pending) if (await link.refreshConversion(l.id)) converted++;

    console.log(
      apply
        ? `\nĐã ghi: thêm ${missing.length} kênh kết nối, gắn ${linked} lead, chuyển đổi thêm ${converted} lead đã gắn sẵn.`
        : `\nChạy thử (không ghi). Thêm --apply để ghi.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
