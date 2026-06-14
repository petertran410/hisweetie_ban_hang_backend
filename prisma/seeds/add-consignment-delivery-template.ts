// prisma/seeds/add-consignment-delivery-template.ts
//
// Seed thêm 1 mẫu in ký gửi "giao hàng" — chỉ số lượng + NSX, KHÔNG giá — để kho
// in đi giao hàng (templateFor: 'consignment', code: 'KG_DELIVERY', isDefault: false).
// Đăng ký thêm 2 biến item (NSX, Ghi_Chu_Hang_Hoa) cho consignment.
// An toàn re-run: upsert biến theo (templateFor,key); upsert + cập nhật content template.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Biến item bổ sung cho phiếu ký gửi (mapItem ở BE đã trả NSX + Ghi_Chu_Hang_Hoa).
const ITEM_VARIABLES = [
  { key: 'NSX', label: 'NSX (ngày sản xuất)', group: 'Hàng hóa', sortOrder: 6 },
  {
    key: 'Ghi_Chu_Hang_Hoa',
    label: 'Ghi chú hàng hóa',
    group: 'Hàng hóa',
    sortOrder: 7,
  },
];

const DELIVERY_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px; line-height: 1.6;">
<div style="text-align: center;">
<div style="text-align: center;">
<p style="margin: 0 0 6px 0;">{Chi_Nhanh_Ban_Hang}</p>
<h1 style="margin: 0 0 8px 0;"><br>PHIẾU K&Yacute; GỬI</h1>
<p style="margin: 0 0 12px 0;">M&atilde; k&yacute; gửi: <strong>{Ma_Ky_Gui}</strong></p>
<div>&nbsp;</div>
</div>
<div style="margin-top: 12px;">
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Kh&aacute;ch h&agrave;ng: </strong>{Khach_Hang} - {So_Dien_Thoai}</p>
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Địa chỉ giao:</strong> {Dia_Chi_Giao_Hang} - {Phuong_Xa_Giao_Hang} - {Khu_Vuc_Giao_Hang}</p>
<p style="text-align: left; margin: 0 0 10px 0;"><strong>Ghi ch&uacute; kh&aacute;ch h&agrave;ng: </strong>{Ghi_Chu_Khach_Hang}</p>
<p style="text-align: left; margin: 0 0 12px 0;"><strong>Nh&acirc;n vi&ecirc;n: </strong>{Nhan_Vien_Ban_Hang} - {Dien_Thoai_Nguoi_Ban}</p>
</div>
</div>
<div style="margin-bottom: 12px;"><strong>Ghi ch&uacute; giao h&agrave;ng:</strong> {Ghi_Chu_Giao_Hang}</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 12px; line-height: 1.5; height: 79.2285px;" border="1">
<thead>
<tr style="height: 30.6152px;">
<th style="padding: 6px; width: 28.9951%;">T&ecirc;n h&agrave;ng</th>
<th style="padding: 6px; width: 28.9951%;">NSX</th>
<th style="padding: 6px; width: 42.0097%;">Số lượng</th>
</tr>
</thead>
<tbody>
<tr style="height: 48.6133px;">
<td style="padding: 6px; width: 28.9951%;">{Ten_Hang_Hoa}<br><em><strong>{Ghi_Chu_Hang_Hoa}</strong></em></td>
<td style="padding: 6px; width: 28.9951%;">{NSX}</td>
<td style="text-align: center; padding: 6px; width: 42.0097%;">{So_Luong}</td>
</tr>
</tbody>
</table>
<div style="margin-top: 12px; line-height: 1.6;"><strong>Ghi ch&uacute;:</strong> {Ghi_Chu}</div>
<div style="display: flex; justify-content: space-between; margin-top: 32px; text-align: center; line-height: 1.6;">
<div>Người giao h&agrave;ng<br>{Nguoi_Lap}</div>
<div>Người nhận h&agrave;ng</div>
</div>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding consignment delivery print template (no price)...');

  // Đăng ký biến item bổ sung (NSX, Ghi_Chu_Hang_Hoa) cho consignment.
  for (const v of ITEM_VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: 'consignment', key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: true,
      },
      create: {
        templateFor: 'consignment',
        key: v.key,
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: true,
      },
    });
  }
  console.log(`  ✅ Upserted ${ITEM_VARIABLES.length} item variables`);

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
      templateFor_code: { templateFor: 'consignment', code: 'KG_DELIVERY' },
    },
    update: {
      name: 'Phiếu ký gửi giao hàng (không giá)',
      content: DELIVERY_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
    },
    create: {
      name: 'Phiếu ký gửi giao hàng (không giá)',
      code: 'KG_DELIVERY',
      templateFor: 'consignment',
      content: DELIVERY_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: false,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted template KG_DELIVERY');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
