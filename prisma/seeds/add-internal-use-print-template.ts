// prisma/seeds/add-internal-use-print-template.ts
//
// Seed biến + 1 template in mặc định cho phiếu xuất dùng nội bộ
// (templateFor: 'internal_use'). An toàn re-run: upsert theo
// (templateFor,key) cho biến và (templateFor,code) cho template.
//
// Cách chạy:  yarn seed:internal-use-print
//
// Lưu ý: file này KHÔNG tự gán quyền in cho role nào. Super Admin đã bypass
// toàn bộ quyền nên in được mặc định. Nếu muốn phân quyền nút In cho role
// thường, bạn tự gán qua UI phân quyền (hiện nút In không gate quyền nên ai
// xem được phiếu đều in được, giống hóa đơn/đơn hàng).

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VARIABLES = [
  // Cửa hàng
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng', group: 'Cửa hàng', sortOrder: 1 },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ cửa hàng', group: 'Cửa hàng', sortOrder: 2 },
  { key: 'So_Dien_Thoai_Cua_Hang', label: 'Điện thoại cửa hàng', group: 'Cửa hàng', sortOrder: 3 },
  // Phiếu
  { key: 'Ma_Xuat_Dung_Noi_Bo', label: 'Mã xuất dùng nội bộ', group: 'Phiếu', sortOrder: 1 },
  { key: 'Ngay', label: 'Ngày', group: 'Phiếu', sortOrder: 2 },
  { key: 'Thang', label: 'Tháng', group: 'Phiếu', sortOrder: 3 },
  { key: 'Nam', label: 'Năm', group: 'Phiếu', sortOrder: 4 },
  { key: 'Chi_Nhanh', label: 'Chi nhánh', group: 'Phiếu', sortOrder: 5 },
  { key: 'Muc_Dich_Su_Dung', label: 'Mục đích sử dụng', group: 'Phiếu', sortOrder: 6 },
  { key: 'Ghi_Chu', label: 'Ghi chú', group: 'Phiếu', sortOrder: 7 },
  // Nhân viên
  { key: 'Nguoi_Su_Dung', label: 'Người sử dụng', group: 'Nhân viên', sortOrder: 1 },
  { key: 'Nhan_Vien_Ban_Hang', label: 'Nhân viên lập', group: 'Nhân viên', sortOrder: 2 },
  { key: 'Nguoi_Lap', label: 'Người lập', group: 'Nhân viên', sortOrder: 3 },
  // Tổng tiền
  { key: 'Tong_Gia_Tri', label: 'Tổng giá trị xuất', group: 'Tổng tiền', sortOrder: 1 },
  { key: 'Tong_Gia_Tri_Bang_Chu', label: 'Tổng giá trị bằng chữ', group: 'Tổng tiền', sortOrder: 2 },
  // Hàng hóa (item)
  { key: 'Ma_Hang', label: 'Mã hàng', group: 'Hàng hóa', sortOrder: 1, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng hóa', group: 'Hàng hóa', sortOrder: 2, isItemVariable: true },
  { key: 'Don_Vi_Tinh', label: 'Đơn vị tính', group: 'Hàng hóa', sortOrder: 3, isItemVariable: true },
  { key: 'So_Luong', label: 'Số lượng xuất', group: 'Hàng hóa', sortOrder: 4, isItemVariable: true },
  { key: 'Gia_Von', label: 'Giá vốn', group: 'Hàng hóa', sortOrder: 5, isItemVariable: true },
  { key: 'Gia_Tri_Xuat', label: 'Giá trị xuất', group: 'Hàng hóa', sortOrder: 6, isItemVariable: true },
];

const DEFAULT_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px;">
  <div style="text-align:center;">
    <h2 style="margin:0;">PHIẾU XUẤT DÙNG NỘI BỘ</h2>
    <div>{Ten_Cua_Hang}</div>
    <div>{Dia_Chi_Cua_Hang}</div>
    <div>ĐT: {So_Dien_Thoai_Cua_Hang}</div>
  </div>
  <hr/>
  <div>Mã phiếu: <b>{Ma_Xuat_Dung_Noi_Bo}</b></div>
  <div>Ngày {Ngay} tháng {Thang} năm {Nam}</div>
  <div>Chi nhánh: {Chi_Nhanh}</div>
  <div>Mục đích sử dụng: {Muc_Dich_Su_Dung}</div>
  <div>Người sử dụng: {Nguoi_Su_Dung}</div>
  <table style="width:100%; border-collapse:collapse; margin-top:8px;" border="1">
    <thead>
      <tr>
        <th>Mã hàng</th><th>Tên hàng</th><th>ĐVT</th><th>SL xuất</th><th>Giá vốn</th><th>Giá trị xuất</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>{Ma_Hang}</td><td>{Ten_Hang_Hoa}</td><td style="text-align:center;">{Don_Vi_Tinh}</td>
        <td style="text-align:center;">{So_Luong}</td>
        <td style="text-align:right;">{Gia_Von}</td><td style="text-align:right;">{Gia_Tri_Xuat}</td>
      </tr>
    </tbody>
  </table>
  <div style="text-align:right; margin-top:8px;">
    <div><b>Tổng giá trị xuất: {Tong_Gia_Tri}</b></div>
    <div><i>Bằng chữ: {Tong_Gia_Tri_Bang_Chu}</i></div>
  </div>
  <div style="margin-top:8px;">Ghi chú: {Ghi_Chu}</div>
  <div style="display:flex; justify-content:space-between; margin-top:24px; text-align:center;">
    <div>Người lập<br/>{Nguoi_Lap}</div>
    <div>Người sử dụng<br/>{Nguoi_Su_Dung}</div>
    <div>Thủ kho</div>
  </div>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding internal_use print variables + template...');

  for (const v of VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: 'internal_use', key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: !!(v as any).isItemVariable,
      },
      create: {
        templateFor: 'internal_use',
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
    where: {
      templateFor_code: { templateFor: 'internal_use', code: 'XDNB_DEFAULT' },
    },
    update: {},
    create: {
      name: 'Phiếu xuất dùng nội bộ mặc định',
      code: 'XDNB_DEFAULT',
      templateFor: 'internal_use',
      content: DEFAULT_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: true,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted default template XDNB_DEFAULT');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
