// prisma/seeds/add-consignment-return-template.ts
//
// Seed mẫu in "Phiếu hoàn hàng ký gửi" (templateFor: 'consignment', code: 'KG_RETURN',
// isDefault: false) + đăng ký các biến item riêng cho phiếu hoàn (SL_Hoan, Hang_Tot,
// Loai_B, Can_Date) và 2 biến scalar (Ma_Hoan_Ky_Gui, Tong_SL_Hoan).
// In bằng entityType 'consignment_return' (loader riêng ở BE), template.templateFor
// vẫn là 'consignment' để dùng chung tab "Ký gửi" + bộ biến item.
// An toàn re-run: upsert biến theo (templateFor,key); upsert + cập nhật content template.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Biến item bổ sung cho phiếu hoàn ký gửi.
const ITEM_VARIABLES = [
  { key: 'SL_Hoan', label: 'SL hoàn', group: 'Hàng hóa', sortOrder: 8 },
  { key: 'Hang_Tot', label: 'Hàng tốt', group: 'Hàng hóa', sortOrder: 9 },
  { key: 'Loai_B', label: 'Loại B', group: 'Hàng hóa', sortOrder: 10 },
  { key: 'Can_Date', label: 'Cận date', group: 'Hàng hóa', sortOrder: 11 },
];

// Biến scalar bổ sung (hiển thị trong palette khi sửa mẫu).
const SCALAR_VARIABLES = [
  { key: 'Ma_Hoan_Ky_Gui', label: 'Mã phiếu hoàn', group: 'Phiếu', sortOrder: 4 },
  { key: 'Tong_SL_Hoan', label: 'Tổng SL hoàn', group: 'Tổng tiền', sortOrder: 5 },
];

const RETURN_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px; line-height: 1.6;">
<div style="text-align: center;">
<p style="margin: 0 0 6px 0;">{Ten_Cua_Hang}</p>
<h1 style="margin: 0 0 8px 0;">PHIẾU HOÀN HÀNG KÝ GỬI</h1>
<p style="margin: 0 0 12px 0;">Mã phiếu hoàn: <strong>{Ma_Hoan_Ky_Gui}</strong></p>
</div>
<div style="margin-top: 12px;">
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Mã ký gửi gốc: </strong>{Ma_Ky_Gui}</p>
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Khách hàng: </strong>{Khach_Hang} - {So_Dien_Thoai}</p>
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Địa chỉ: </strong>{Dia_Chi_Khach_Hang}</p>
<p style="text-align: left; margin: 0 0 12px 0;"><strong>Ngày: </strong>{Ngay}</p>
</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 12px; line-height: 1.5;" border="1">
<thead>
<tr>
<th style="padding: 6px;">Mã hàng</th>
<th style="padding: 6px;">Tên hàng</th>
<th style="padding: 6px;">NSX</th>
<th style="padding: 6px;">Hàng tốt</th>
<th style="padding: 6px;">Loại B</th>
<th style="padding: 6px;">Cận date</th>
<th style="padding: 6px;">SL hoàn</th>
</tr>
</thead>
<tbody>
<tr>
<td style="padding: 6px;">{Ma_Hang}</td>
<td style="padding: 6px;">{Ten_Hang_Hoa}<br><em><strong>{Ghi_Chu_Hang_Hoa}</strong></em></td>
<td style="padding: 6px; text-align: center;">{NSX}</td>
<td style="padding: 6px; text-align: center;">{Hang_Tot}</td>
<td style="padding: 6px; text-align: center;">{Loai_B}</td>
<td style="padding: 6px; text-align: center;">{Can_Date}</td>
<td style="padding: 6px; text-align: center;">{SL_Hoan}</td>
</tr>
</tbody>
</table>
<div style="text-align: right; margin-top: 8px;"><strong>Tổng SL hoàn: {Tong_SL_Hoan}</strong></div>
<div style="margin-top: 8px;"><strong>Ghi chú:</strong> {Ghi_Chu}</div>
<div style="display: flex; justify-content: space-between; margin-top: 32px; text-align: center; line-height: 1.6;">
<div>Người lập<br>{Nguoi_Lap}</div>
<div>Người nhận hàng</div>
</div>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding consignment return print template...');

  for (const v of [...ITEM_VARIABLES, ...SCALAR_VARIABLES]) {
    const isItem = ITEM_VARIABLES.includes(v as any);
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: 'consignment', key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: isItem,
      },
      create: {
        templateFor: 'consignment',
        key: v.key,
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: isItem,
      },
    });
  }
  console.log(
    `  ✅ Upserted ${ITEM_VARIABLES.length} item + ${SCALAR_VARIABLES.length} scalar variables`,
  );

  // Reset sequence id của print_templates để tránh xung đột id khi insert.
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('print_templates', 'id'),
      COALESCE((SELECT MAX(id) FROM print_templates), 0) + 1,
      false
    )
  `);

  const admin =
    (await prisma.user.findFirst({ where: { email: { contains: 'admin' } } })) ||
    (await prisma.user.findFirst());
  if (!admin) {
    console.log('⚠️  Không tìm thấy user nào để gán createdBy — bỏ qua template.');
    return;
  }

  await prisma.printTemplate.upsert({
    where: {
      templateFor_code: { templateFor: 'consignment', code: 'KG_RETURN' },
    },
    update: {
      name: 'Phiếu hoàn hàng ký gửi',
      content: RETURN_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
    },
    create: {
      name: 'Phiếu hoàn hàng ký gửi',
      code: 'KG_RETURN',
      templateFor: 'consignment',
      content: RETURN_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: false,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted template KG_RETURN');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
