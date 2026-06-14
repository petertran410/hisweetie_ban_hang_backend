// prisma/seeds/add-consignment-print-template.ts
//
// Seed biến + 1 template in mặc định cho phiếu ký gửi (templateFor: 'consignment').
// An toàn re-run: upsert theo (templateFor,key) cho biến và (templateFor,code) cho template.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VARIABLES = [
  // Cửa hàng
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng', group: 'Cửa hàng', sortOrder: 1 },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ cửa hàng', group: 'Cửa hàng', sortOrder: 2 },
  { key: 'Dien_Thoai_Cua_Hang', label: 'Điện thoại cửa hàng', group: 'Cửa hàng', sortOrder: 3 },
  // Phiếu
  { key: 'Ma_Ky_Gui', label: 'Mã ký gửi', group: 'Phiếu', sortOrder: 1 },
  { key: 'Ngay_Thang_Nam', label: 'Ngày tháng năm', group: 'Phiếu', sortOrder: 2 },
  { key: 'Ghi_Chu', label: 'Ghi chú', group: 'Phiếu', sortOrder: 3 },
  // Khách hàng
  { key: 'Khach_Hang', label: 'Tên khách hàng', group: 'Khách hàng', sortOrder: 1 },
  { key: 'Dien_Thoai_Khach', label: 'Điện thoại khách', group: 'Khách hàng', sortOrder: 2 },
  { key: 'Dia_Chi_Khach', label: 'Địa chỉ khách', group: 'Khách hàng', sortOrder: 3 },
  // Giao hàng
  { key: 'Nguoi_Nhan', label: 'Người nhận', group: 'Giao hàng', sortOrder: 1 },
  { key: 'Dien_Thoai_Nhan', label: 'SĐT người nhận', group: 'Giao hàng', sortOrder: 2 },
  { key: 'Dia_Chi_Giao_Hang', label: 'Địa chỉ giao hàng', group: 'Giao hàng', sortOrder: 3 },
  { key: 'Ghi_Chu_Giao_Hang', label: 'Ghi chú giao hàng', group: 'Giao hàng', sortOrder: 4 },
  // Nhân viên
  { key: 'Nhan_Vien_Ban_Hang', label: 'Nhân viên bán hàng', group: 'Nhân viên', sortOrder: 1 },
  { key: 'Nguoi_Lap', label: 'Người lập', group: 'Nhân viên', sortOrder: 2 },
  // Tổng tiền
  { key: 'Tong_Tien_Hang', label: 'Tổng tiền hàng', group: 'Tổng tiền', sortOrder: 1 },
  { key: 'Giam_Gia', label: 'Giảm giá', group: 'Tổng tiền', sortOrder: 2 },
  { key: 'Tong_Can_Thanh_Toan', label: 'Tổng cộng', group: 'Tổng tiền', sortOrder: 3 },
  { key: 'Tong_Can_Thanh_Toan_Bang_Chu', label: 'Tổng cộng bằng chữ', group: 'Tổng tiền', sortOrder: 4 },
  // Hàng hóa (item)
  { key: 'Ma_Hang', label: 'Mã hàng', group: 'Hàng hóa', sortOrder: 1, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng hóa', group: 'Hàng hóa', sortOrder: 2, isItemVariable: true },
  { key: 'So_Luong', label: 'Số lượng', group: 'Hàng hóa', sortOrder: 3, isItemVariable: true },
  { key: 'Don_Gia', label: 'Đơn giá', group: 'Hàng hóa', sortOrder: 4, isItemVariable: true },
  { key: 'Thanh_Tien', label: 'Thành tiền', group: 'Hàng hóa', sortOrder: 5, isItemVariable: true },
];

const DEFAULT_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px;">
  <div style="text-align:center;">
    <h2 style="margin:0;">PHIẾU KÝ GỬI</h2>
    <div>{Ten_Cua_Hang}</div>
    <div>{Dia_Chi_Cua_Hang}</div>
    <div>ĐT: {Dien_Thoai_Cua_Hang}</div>
  </div>
  <hr/>
  <div>Mã ký gửi: <b>{Ma_Ky_Gui}</b></div>
  <div>Ngày: {Ngay_Thang_Nam}</div>
  <div>Khách hàng: {Khach_Hang} - {Dien_Thoai_Khach}</div>
  <div>Địa chỉ: {Dia_Chi_Khach}</div>
  <table style="width:100%; border-collapse:collapse; margin-top:8px;" border="1">
    <thead>
      <tr>
        <th>Mã hàng</th><th>Tên hàng</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>{Ma_Hang}</td><td>{Ten_Hang_Hoa}</td><td style="text-align:center;">{So_Luong}</td>
        <td style="text-align:right;">{Don_Gia}</td><td style="text-align:right;">{Thanh_Tien}</td>
      </tr>
    </tbody>
  </table>
  <div style="text-align:right; margin-top:8px;">
    <div>Tổng tiền hàng: {Tong_Tien_Hang}</div>
    <div>Giảm giá: {Giam_Gia}</div>
    <div><b>Tổng cộng: {Tong_Can_Thanh_Toan}</b></div>
    <div><i>Bằng chữ: {Tong_Can_Thanh_Toan_Bang_Chu}</i></div>
  </div>
  <div style="margin-top:8px;">Ghi chú: {Ghi_Chu}</div>
  <div style="display:flex; justify-content:space-between; margin-top:24px; text-align:center;">
    <div>Người lập<br/>{Nguoi_Lap}</div>
    <div>Người nhận ký gửi</div>
  </div>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding consignment print variables + template...');

  for (const v of VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: 'consignment', key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: !!(v as any).isItemVariable,
      },
      create: {
        templateFor: 'consignment',
        key: v.key,
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: !!(v as any).isItemVariable,
      },
    });
  }
  console.log(`  ✅ Upserted ${VARIABLES.length} variables`);

  // Reset sequence id của print_templates để tránh xung đột id khi insert.
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('print_templates', 'id'),
      COALESCE((SELECT MAX(id) FROM print_templates), 0) + 1,
      false
    )
  `);

  // Cần 1 user để gán createdBy.
  const admin =
    (await prisma.user.findFirst({ where: { email: { contains: 'admin' } } })) ||
    (await prisma.user.findFirst());
  if (!admin) {
    console.log('⚠️  Không tìm thấy user nào để gán createdBy — bỏ qua template.');
    return;
  }

  await prisma.printTemplate.upsert({
    where: { templateFor_code: { templateFor: 'consignment', code: 'KG_DEFAULT' } },
    update: {},
    create: {
      name: 'Phiếu ký gửi mặc định',
      code: 'KG_DEFAULT',
      templateFor: 'consignment',
      content: DEFAULT_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: true,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted default template KG_DEFAULT');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
