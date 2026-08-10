// prisma/seeds/add-supplier-return-print-template.ts
//
// Seed biến + 1 template in mặc định cho phiếu TRẢ HÀNG NHẬP (trả hàng cho nhà
// cung cấp) — templateFor: 'supplier_return'. An toàn re-run: upsert biến theo
// (templateFor,key) và template theo (templateFor,code). File này chỉ upsert,
// KHÔNG xóa dữ liệu.
//
// Cách chạy:  yarn seed:supplier-return-print
//
// Lưu ý: file này KHÔNG tự gán quyền in cho role nào. Super Admin bypass toàn bộ
// quyền nên in được mặc định. Nút In gate theo quyền 'print_templates:view'
// (giống các phiếu khác) — ai xem được mẫu in đều in được.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VARIABLES = [
  // Cửa hàng
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng', group: 'Cửa hàng', sortOrder: 1 },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ cửa hàng', group: 'Cửa hàng', sortOrder: 2 },
  { key: 'So_Dien_Thoai_Cua_Hang', label: 'Điện thoại cửa hàng', group: 'Cửa hàng', sortOrder: 3 },
  // Phiếu
  { key: 'Ma_Tra_Hang_Nhap', label: 'Mã trả hàng nhập', group: 'Phiếu', sortOrder: 1 },
  { key: 'Ma_Nhap_Hang_Goc', label: 'Mã phiếu nhập gốc', group: 'Phiếu', sortOrder: 2 },
  { key: 'Ngay', label: 'Ngày', group: 'Phiếu', sortOrder: 3 },
  { key: 'Thang', label: 'Tháng', group: 'Phiếu', sortOrder: 4 },
  { key: 'Nam', label: 'Năm', group: 'Phiếu', sortOrder: 5 },
  { key: 'Ghi_Chu', label: 'Ghi chú', group: 'Phiếu', sortOrder: 6 },
  // Nhà cung cấp
  { key: 'Ma_Nha_Cung_Cap', label: 'Mã nhà cung cấp', group: 'Nhà cung cấp', sortOrder: 1 },
  { key: 'Ten_Nha_Cung_Cap', label: 'Tên nhà cung cấp', group: 'Nhà cung cấp', sortOrder: 2 },
  { key: 'So_Dien_Thoai_NCC', label: 'Điện thoại NCC', group: 'Nhà cung cấp', sortOrder: 3 },
  { key: 'Dia_Chi_NCC', label: 'Địa chỉ NCC', group: 'Nhà cung cấp', sortOrder: 4 },
  // Nhân viên
  { key: 'Nhan_Vien_Ban_Hang', label: 'Nhân viên lập', group: 'Nhân viên', sortOrder: 1 },
  { key: 'Nguoi_Lap', label: 'Người lập', group: 'Nhân viên', sortOrder: 2 },
  // Tổng tiền
  { key: 'Tong_Tien_Tra', label: 'Tổng tiền trả', group: 'Tổng tiền', sortOrder: 1 },
  { key: 'Tien_Hoan', label: 'Tiền hoàn', group: 'Tổng tiền', sortOrder: 2 },
  { key: 'Da_Hoan_Tra', label: 'Đã hoàn trả', group: 'Tổng tiền', sortOrder: 3 },
  { key: 'Tong_Tien_Tra_Bang_Chu', label: 'Tổng tiền trả bằng chữ', group: 'Tổng tiền', sortOrder: 4 },
  // Hàng hóa (item)
  { key: 'Ma_Hang', label: 'Mã hàng', group: 'Hàng hóa', sortOrder: 1, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng hóa', group: 'Hàng hóa', sortOrder: 2, isItemVariable: true },
  { key: 'Don_Vi_Tinh', label: 'Đơn vị tính', group: 'Hàng hóa', sortOrder: 3, isItemVariable: true },
  { key: 'So_Luong', label: 'Số lượng trả', group: 'Hàng hóa', sortOrder: 4, isItemVariable: true },
  { key: 'Don_Gia', label: 'Đơn giá trả', group: 'Hàng hóa', sortOrder: 5, isItemVariable: true },
  { key: 'Thanh_Tien', label: 'Thành tiền', group: 'Hàng hóa', sortOrder: 6, isItemVariable: true },
  { key: 'Ghi_Chu_Hang_Hoa', label: 'Ghi chú hàng hóa', group: 'Hàng hóa', sortOrder: 7, isItemVariable: true },
];

const DEFAULT_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px;">
  <div style="text-align:center;">
    <h2 style="margin:0;">PHIẾU TRẢ HÀNG NHẬP</h2>
    <div>{Ten_Cua_Hang}</div>
    <div>{Dia_Chi_Cua_Hang}</div>
    <div>ĐT: {So_Dien_Thoai_Cua_Hang}</div>
  </div>
  <hr/>
  <div>Mã phiếu: <b>{Ma_Tra_Hang_Nhap}</b></div>
  <div>Mã phiếu nhập gốc: {Ma_Nhap_Hang_Goc}</div>
  <div>Ngày {Ngay} tháng {Thang} năm {Nam}</div>
  <div>Nhà cung cấp: {Ten_Nha_Cung_Cap} ({Ma_Nha_Cung_Cap})</div>
  <div>Điện thoại: {So_Dien_Thoai_NCC}</div>
  <div>Địa chỉ: {Dia_Chi_NCC}</div>
  <table style="width:100%; border-collapse:collapse; margin-top:8px;" border="1">
    <thead>
      <tr>
        <th>Mã hàng</th><th>Tên hàng</th><th>ĐVT</th><th>SL trả</th><th>Đơn giá</th><th>Thành tiền</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>{Ma_Hang}</td>
        <td>{Ten_Hang_Hoa}<br/><em><strong>{Ghi_Chu_Hang_Hoa}</strong></em></td>
        <td style="text-align:center;">{Don_Vi_Tinh}</td>
        <td style="text-align:center;">{So_Luong}</td>
        <td style="text-align:right;">{Don_Gia}</td>
        <td style="text-align:right;">{Thanh_Tien}</td>
      </tr>
    </tbody>
  </table>
  <div style="text-align:right; margin-top:8px;">
    <div><b>Tổng tiền trả: {Tong_Tien_Tra}</b></div>
    <div>Tiền hoàn: {Tien_Hoan}</div>
    <div>Đã hoàn trả: {Da_Hoan_Tra}</div>
    <div><i>Bằng chữ: {Tong_Tien_Tra_Bang_Chu}</i></div>
  </div>
  <div style="margin-top:8px;">Ghi chú: {Ghi_Chu}</div>
  <div style="display:flex; justify-content:space-between; margin-top:24px; text-align:center;">
    <div>Người lập<br/>{Nguoi_Lap}</div>
    <div>Thủ kho</div>
    <div>Nhà cung cấp</div>
  </div>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding supplier_return print variables + template...');

  for (const v of VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: 'supplier_return', key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: !!(v as any).isItemVariable,
      },
      create: {
        templateFor: 'supplier_return',
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
      templateFor_code: {
        templateFor: 'supplier_return',
        code: 'THN_DEFAULT',
      },
    },
    update: {},
    create: {
      name: 'Phiếu trả hàng nhập mặc định',
      code: 'THN_DEFAULT',
      templateFor: 'supplier_return',
      content: DEFAULT_TEMPLATE,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: true,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted default template THN_DEFAULT');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
