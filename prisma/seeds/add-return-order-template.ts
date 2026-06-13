/**
 * Additive, idempotent: tạo MẪU IN phiếu trả hàng (templateFor='return_order')
 * nếu chưa tồn tại. KHÔNG xóa / KHÔNG ghi đè dữ liệu hiện có.
 *
 * Chạy: npx ts-node prisma/seeds/add-return-order-template.ts
 *
 * Mẫu phỏng theo mẫu in trả hàng của KiotViet, dùng đúng biến do
 * PrintTemplatesService.mapReturnOrder() xuất ra.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TEMPLATE_FOR = 'return_order';
const CODE = 'return_order_default_A5';

const CONTENT = `<p style="text-align:center"><span style="font-family:arial,helvetica,sans-serif;font-size:8pt">{Chi_Nhanh_Ban_Hang}</span><strong><span style="font-family:arial,helvetica,sans-serif;font-size:12pt"><br>PHI&Eacute;U TR&Aacute; H&Agrave;NG<br></span></strong><span style="font-size:8pt">Ng&agrave;y {Ngay}</span><br><span style="font-size:8pt">M&atilde; tr&aacute; h&agrave;ng: {Ma_Tra_Hang}</span><br><span style="font-size:8pt">H&oacute;a đơn gốc: {Ma_Don_Hang_Goc}</span></p>
<p style="text-align:left"><span style="font-size:8pt"><strong>Kh&aacute;ch h&agrave;ng: </strong>{Khach_Hang} - {So_Dien_Thoai}</span></p>
<p style="text-align:left"><span style="font-size:8pt"><strong>Địa chỉ: </strong>{Dia_Chi_Khach_Hang}</span></p>
<p style="text-align:left"><span style="font-size:8pt"><strong>Nh&acirc;n vi&ecirc;n: </strong>{Nhan_Vien_Ban_Hang}</span></p>
<table style="border-collapse:collapse;width:100%;border-width:1px;border-spacing:0px" border="1" cellspacing="0" cellpadding="4"><colgroup><col style="width:55%"><col style="width:15%"><col style="width:10%"><col style="width:20%"></colgroup>
<tbody>
<tr>
<td style="border-width:1px"><span style="font-size:8pt"><strong>Sản phẩm</strong></span></td>
<td style="border-width:1px;text-align:center"><span style="font-size:8pt"><strong>Đơn gi&aacute;</strong></span></td>
<td style="border-width:1px;text-align:center"><span style="font-size:8pt"><strong>SL</strong></span></td>
<td style="border-width:1px;text-align:right"><span style="font-size:8pt"><strong>Th&agrave;nh tiền</strong></span></td>
</tr>
<tr>
<td style="border-width:1px"><strong><span style="font-size:8pt">{Ten_Hang_Hoa}</span></strong><br><em><span style="font-size:8pt">{Ghi_Chu_Hang_Hoa}</span></em></td>
<td style="border-width:1px;text-align:center"><span style="font-size:8pt">{Don_Gia}</span></td>
<td style="border-width:1px;text-align:center"><span style="font-size:8pt">{So_Luong}</span></td>
<td style="border-width:1px;text-align:right"><span style="font-size:8pt">{Thanh_Tien}</span></td>
</tr>
</tbody>
</table>
<table style="border-collapse:collapse;width:100%" border="0" cellspacing="0" cellpadding="4"><colgroup><col style="width:60%"><col style="width:40%"></colgroup>
<tbody>
<tr>
<td style="text-align:right"><span style="font-size:8pt"><strong>Tổng tiền h&agrave;ng trả:</strong></span></td>
<td style="text-align:right"><span style="font-size:8pt">{Tong_Tien_Tra}</span></td>
</tr>
<tr>
<td style="text-align:right"><span style="font-size:8pt"><strong>Đ&atilde; ho&agrave;n trả:</strong></span></td>
<td style="text-align:right"><span style="font-size:8pt">{Da_Hoan_Tra}</span></td>
</tr>
</tbody>
</table>
<p style="text-align:left"><span style="font-size:8pt"><strong>Ghi ch&uacute;: </strong><em>{Ghi_Chu}</em></span></p>
<p style="text-align:center">&nbsp;</p>
<p style="text-align:center"><em><span style="font-size:8pt">Cảm ơn v&agrave; hẹn gặp lại</span></em></p>`;

async function main() {
  const existing = await prisma.printTemplate.findFirst({
    where: { templateFor: TEMPLATE_FOR },
    select: { id: true, name: true, code: true },
  });

  if (existing) {
    console.log(
      `Đã tồn tại mẫu in return_order (id=${existing.id}, code=${existing.code}). Bỏ qua, không ghi đè.`,
    );
    return;
  }

  // createdBy bắt buộc (FK -> User). Lấy creator của 1 template hiện có,
  // fallback sang user nhỏ nhất id (thường là admin).
  const refTemplate = await prisma.printTemplate.findFirst({
    select: { createdBy: true },
    orderBy: { id: 'asc' },
  });
  const fallbackUser = await prisma.user.findFirst({
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const createdBy = refTemplate?.createdBy ?? fallbackUser?.id;
  if (!createdBy) {
    throw new Error('Không tìm thấy user nào để gán createdBy cho mẫu in.');
  }

  const created = await prisma.printTemplate.create({
    data: {
      name: 'Mẫu in trả hàng',
      code: CODE,
      templateFor: TEMPLATE_FOR,
      content: CONTENT,
      paperSize: 'A5',
      orientation: 'portrait',
      isActive: true,
      isDefault: true,
      createdBy,
    },
    select: { id: true, name: true, code: true },
  });

  console.log(
    `Đã tạo mẫu in trả hàng: id=${created.id}, code=${created.code}, name="${created.name}"`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
