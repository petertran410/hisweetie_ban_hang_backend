// prisma/seeds/add-warehouse-export-print-template.ts
//
// Seed biến + 1 mẫu in mặc định cho Phiếu xuất kho theo hóa đơn
// (templateFor: 'warehouse_export', code: 'PXK_DEFAULT', A4 dọc, KHÔNG giá).
// An toàn re-run: upsert theo (templateFor,key) cho biến và (templateFor,code)
// cho template. Re-run KHÔNG ghi đè nội dung mẫu đã chỉnh sửa trên UI.
//
// Cách chạy:  yarn seed:warehouse-export-template
//
// Lưu ý: file này KHÔNG đụng tới quyền. Nút in dùng lại quyền invoices:print.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPLATE_FOR = 'warehouse_export';

const VARIABLES: Array<{
  key: string;
  label: string;
  group: string;
  sortOrder: number;
  isItemVariable?: boolean;
}> = [
  // Cửa hàng
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng', group: 'Cửa hàng', sortOrder: 1 },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ cửa hàng', group: 'Cửa hàng', sortOrder: 2 },
  { key: 'So_Dien_Thoai_Cua_Hang', label: 'Điện thoại cửa hàng', group: 'Cửa hàng', sortOrder: 3 },
  { key: 'Kho_Xuat', label: 'Kho xuất (chi nhánh)', group: 'Cửa hàng', sortOrder: 4 },
  // Phiếu
  { key: 'So_Phieu_Xuat_Kho', label: 'Số phiếu xuất kho', group: 'Phiếu', sortOrder: 1 },
  { key: 'Ma_Hoa_Don', label: 'Mã hóa đơn', group: 'Phiếu', sortOrder: 2 },
  { key: 'Ma_Don_Hang', label: 'Mã đơn hàng', group: 'Phiếu', sortOrder: 3 },
  { key: 'Ngay_Xuat_Kho', label: 'Ngày xuất/giao hàng', group: 'Phiếu', sortOrder: 4 },
  { key: 'Ngay_Hoa_Don', label: 'Ngày hóa đơn', group: 'Phiếu', sortOrder: 5 },
  { key: 'Thang', label: 'Tháng xuất', group: 'Phiếu', sortOrder: 6 },
  { key: 'Nam', label: 'Năm xuất', group: 'Phiếu', sortOrder: 7 },
  { key: 'Ghi_Chu', label: 'Ghi chú hóa đơn', group: 'Phiếu', sortOrder: 8 },
  { key: 'Tong_So_Luong', label: 'Tổng số lượng', group: 'Phiếu', sortOrder: 9 },
  { key: 'Tong_So_Mat_Hang', label: 'Tổng số mặt hàng', group: 'Phiếu', sortOrder: 10 },
  { key: 'Ma_QR_Chung_Tu', label: 'Mã QR chứng từ', group: 'Phiếu', sortOrder: 11 },
  // Khách hàng
  { key: 'Ma_Khach_Hang', label: 'Mã khách hàng', group: 'Khách hàng', sortOrder: 1 },
  { key: 'Khach_Hang', label: 'Tên khách hàng', group: 'Khách hàng', sortOrder: 2 },
  { key: 'So_Dien_Thoai', label: 'Điện thoại khách hàng', group: 'Khách hàng', sortOrder: 3 },
  { key: 'Dia_Chi_Khach_Hang', label: 'Địa chỉ khách hàng', group: 'Khách hàng', sortOrder: 4 },
  // Giao hàng
  { key: 'Nguoi_Nhan', label: 'Người nhận', group: 'Giao hàng', sortOrder: 1 },
  { key: 'Dien_Thoai_Nhan', label: 'Điện thoại người nhận', group: 'Giao hàng', sortOrder: 2 },
  { key: 'Dia_Chi_Giao_Hang', label: 'Địa chỉ giao hàng', group: 'Giao hàng', sortOrder: 3 },
  { key: 'Phuong_Xa_Giao_Hang', label: 'Phường/xã giao hàng', group: 'Giao hàng', sortOrder: 4 },
  { key: 'Khu_Vuc_Giao_Hang', label: 'Khu vực giao hàng', group: 'Giao hàng', sortOrder: 5 },
  { key: 'Ghi_Chu_Giao_Hang', label: 'Ghi chú giao hàng', group: 'Giao hàng', sortOrder: 6 },
  // Nhân viên
  { key: 'Nhan_Vien_Ban_Hang', label: 'Nhân viên bán hàng', group: 'Nhân viên', sortOrder: 1 },
  { key: 'Nguoi_Lap', label: 'Người lập', group: 'Nhân viên', sortOrder: 2 },
  // Hàng hóa (item)
  { key: 'STT', label: 'STT', group: 'Hàng hóa', sortOrder: 1, isItemVariable: true },
  { key: 'Ma_Hang', label: 'Mã hàng', group: 'Hàng hóa', sortOrder: 2, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng hóa', group: 'Hàng hóa', sortOrder: 3, isItemVariable: true },
  { key: 'Don_Vi_Tinh', label: 'Đơn vị tính', group: 'Hàng hóa', sortOrder: 4, isItemVariable: true },
  { key: 'So_Luong', label: 'Số lượng thực xuất', group: 'Hàng hóa', sortOrder: 5, isItemVariable: true },
  { key: 'NSX', label: 'NSX (ngày sản xuất)', group: 'Hàng hóa', sortOrder: 6, isItemVariable: true },
  { key: 'Ghi_Chu_Hang_Hoa', label: 'Ghi chú hàng hóa', group: 'Hàng hóa', sortOrder: 7, isItemVariable: true },
];

const DEFAULT_TEMPLATE = `
<div style="font-family: Arial, sans-serif; font-size: 13px; line-height: 1.5;">
<table style="width: 100%; border-collapse: collapse;">
<tbody>
<tr>
<td style="width: 60%; vertical-align: top; padding: 0;"><strong>{Ten_Cua_Hang}</strong><br>{Dia_Chi_Cua_Hang}<br>ĐT: {So_Dien_Thoai_Cua_Hang}</td>
<td style="width: 40%; vertical-align: top; text-align: right; padding: 0;">Số phiếu: <strong>{So_Phieu_Xuat_Kho}</strong><br>Ngày xuất: {Ngay_Xuat_Kho}</td>
</tr>
</tbody>
</table>
<h1 style="text-align: center; font-size: 22px; margin: 16px 0 12px 0;">PHIẾU XUẤT KHO</h1>
<table style="width: 100%; border-collapse: collapse; margin-bottom: 10px;">
<tbody>
<tr>
<td style="width: 60%; vertical-align: top; padding: 2px 0;"><strong>Khách hàng:</strong> {Khach_Hang}</td>
<td style="width: 40%; vertical-align: top; padding: 2px 0;"><strong>Số hóa đơn:</strong> {Ma_Hoa_Don}</td>
</tr>
<tr>
<td style="vertical-align: top; padding: 2px 0;"><strong>Điện thoại:</strong> {So_Dien_Thoai}</td>
<td style="vertical-align: top; padding: 2px 0;"><strong>Mã đơn hàng:</strong> {Ma_Don_Hang}</td>
</tr>
<tr>
<td style="vertical-align: top; padding: 2px 0;"><strong>Địa chỉ giao:</strong> {Dia_Chi_Giao_Hang}</td>
<td style="vertical-align: top; padding: 2px 0;"><strong>Kho xuất:</strong> {Kho_Xuat}</td>
</tr>
</tbody>
</table>
<table style="width: 100%; border-collapse: collapse;" border="1">
<thead>
<tr>
<th style="padding: 6px; width: 6%;">STT</th>
<th style="padding: 6px; width: 14%;">Mã hàng</th>
<th style="padding: 6px; width: 40%;">Tên hàng hóa</th>
<th style="padding: 6px; width: 10%;">ĐVT</th>
<th style="padding: 6px; width: 12%;">SL thực xuất</th>
<th style="padding: 6px; width: 18%;">Ghi chú</th>
</tr>
</thead>
<tbody>
<tr>
<td style="padding: 6px; text-align: center;">{STT}</td>
<td style="padding: 6px;">{Ma_Hang}</td>
<td style="padding: 6px;">{Ten_Hang_Hoa}</td>
<td style="padding: 6px; text-align: center;">{Don_Vi_Tinh}</td>
<td style="padding: 6px; text-align: center;">{So_Luong}</td>
<td style="padding: 6px;">{Ghi_Chu_Hang_Hoa}</td>
</tr>
<tr>
<td style="padding: 6px; text-align: right;" colspan="4"><strong>Tổng số lượng ({Tong_So_Mat_Hang} mặt hàng)</strong></td>
<td style="padding: 6px; text-align: center;"><strong>{Tong_So_Luong}</strong></td>
<td style="padding: 6px;">&nbsp;</td>
</tr>
</tbody>
</table>
<p style="margin: 10px 0 0 0;"><strong>Ghi chú:</strong> {Ghi_Chu}</p>
<table style="width: 100%; border-collapse: collapse; margin-top: 28px; text-align: center;">
<tbody>
<tr>
<td style="width: 25%; padding: 0;"><strong>Người lập phiếu</strong><br><em>(Ký, họ tên)</em></td>
<td style="width: 25%; padding: 0;"><strong>Thủ kho</strong><br><em>(Ký, họ tên)</em></td>
<td style="width: 25%; padding: 0;"><strong>Người giao hàng</strong><br><em>(Ký, họ tên)</em></td>
<td style="width: 25%; padding: 0;"><strong>Người nhận hàng</strong><br><em>(Ký, họ tên)</em></td>
</tr>
<tr>
<td style="height: 80px; vertical-align: bottom; padding: 0;">{Nguoi_Lap}</td>
<td>&nbsp;</td>
<td>&nbsp;</td>
<td>&nbsp;</td>
</tr>
</tbody>
</table>
</div>
`.trim();

async function main() {
  console.log('🌱 Seeding warehouse export (phiếu xuất kho) print template...');

  for (const v of VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: { templateFor_key: { templateFor: TEMPLATE_FOR, key: v.key } },
      update: {
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: v.isItemVariable ?? false,
      },
      create: {
        templateFor: TEMPLATE_FOR,
        key: v.key,
        label: v.label,
        group: v.group,
        sortOrder: v.sortOrder,
        isItemVariable: v.isItemVariable ?? false,
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

  const admin =
    (await prisma.user.findFirst({ where: { email: { contains: 'admin' } } })) ||
    (await prisma.user.findFirst());
  if (!admin) {
    console.log('⚠️  Không tìm thấy user nào để gán createdBy — bỏ qua template.');
    return;
  }

  // update: {} — không ghi đè mẫu người dùng đã chỉnh trên UI khi re-run.
  await prisma.printTemplate.upsert({
    where: {
      templateFor_code: { templateFor: TEMPLATE_FOR, code: 'PXK_DEFAULT' },
    },
    update: {},
    create: {
      name: 'Phiếu xuất kho',
      code: 'PXK_DEFAULT',
      templateFor: TEMPLATE_FOR,
      content: DEFAULT_TEMPLATE,
      paperSize: 'A4',
      orientation: 'portrait',
      isActive: true,
      isDefault: true,
      createdBy: admin.id,
    },
  });
  console.log('  ✅ Upserted template PXK_DEFAULT');
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
