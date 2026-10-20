// prisma/seeds/add-cash-advance-print-templates.ts
//
// Seed biến + mẫu in mặc định cho Phiếu tạm ứng (templateFor 'cash_advance',
// code 'TU_DEFAULT') và Phiếu hoàn ứng ('cash_advance_refund', 'HU_DEFAULT'):
// khổ A5 ngang, bố cục kiểu phiếu séc, có ô ký để upload lại bản đã ký.
// An toàn re-run: upsert theo (templateFor,key) cho biến và (templateFor,code)
// cho template. Re-run KHÔNG ghi đè nội dung mẫu đã chỉnh sửa trên UI.
//
// Cách chạy:  yarn seed:cash-advance-print
//
// Lưu ý: file này KHÔNG đụng tới quyền.

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Variable = {
  key: string;
  label: string;
  group: string;
  sortOrder: number;
};

const STORE_VARIABLES: Variable[] = [
  {
    key: 'Ten_Cua_Hang',
    label: 'Tên cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 1,
  },
  {
    key: 'Dia_Chi_Cua_Hang',
    label: 'Địa chỉ cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 2,
  },
  {
    key: 'So_Dien_Thoai_Cua_Hang',
    label: 'Điện thoại cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 3,
  },
  {
    key: 'Kho',
    label: 'Kho (quỹ chi/thu tiền)',
    group: 'Cửa hàng',
    sortOrder: 4,
  },
];

const ADVANCE_VARIABLES: Variable[] = [
  ...STORE_VARIABLES,
  {
    key: 'Ma_Phieu_Tam_Ung',
    label: 'Mã phiếu tạm ứng',
    group: 'Phiếu',
    sortOrder: 1,
  },
  { key: 'Ngay_Tam_Ung', label: 'Ngày tạm ứng', group: 'Phiếu', sortOrder: 2 },
  { key: 'Ngay', label: 'Ngày (dd/mm/yyyy)', group: 'Phiếu', sortOrder: 3 },
  { key: 'Thang', label: 'Tháng', group: 'Phiếu', sortOrder: 4 },
  { key: 'Nam', label: 'Năm', group: 'Phiếu', sortOrder: 5 },
  { key: 'Ky_Tam_Ung', label: 'Kỳ tạm ứng', group: 'Phiếu', sortOrder: 6 },
  { key: 'Tu_Ngay', label: 'Kỳ từ ngày', group: 'Phiếu', sortOrder: 7 },
  { key: 'Den_Ngay', label: 'Kỳ đến ngày', group: 'Phiếu', sortOrder: 8 },
  {
    key: 'Han_Hoan_Ung',
    label: 'Hạn làm hoàn ứng',
    group: 'Phiếu',
    sortOrder: 9,
  },
  { key: 'Noi_Dung', label: 'Nội dung tạm ứng', group: 'Phiếu', sortOrder: 10 },
  { key: 'So_Tien', label: 'Số tiền', group: 'Phiếu', sortOrder: 11 },
  {
    key: 'So_Tien_Bang_Chu',
    label: 'Số tiền bằng chữ',
    group: 'Phiếu',
    sortOrder: 12,
  },
  { key: 'Trang_Thai', label: 'Trạng thái', group: 'Phiếu', sortOrder: 13 },
  {
    key: 'Nguoi_Tam_Ung',
    label: 'Người nhận tạm ứng',
    group: 'Nhân viên',
    sortOrder: 1,
  },
  {
    key: 'Nguoi_Lap',
    label: 'Người lập phiếu',
    group: 'Nhân viên',
    sortOrder: 2,
  },
  {
    key: 'Nguoi_Xac_Nhan',
    label: 'Người xác nhận giao tiền',
    group: 'Nhân viên',
    sortOrder: 3,
  },
];

const REFUND_VARIABLES: Variable[] = [
  ...STORE_VARIABLES,
  {
    key: 'Ma_Phieu_Hoan_Ung',
    label: 'Mã phiếu hoàn ứng',
    group: 'Phiếu',
    sortOrder: 1,
  },
  {
    key: 'Ma_Phieu_Tam_Ung',
    label: 'Mã phiếu tạm ứng',
    group: 'Phiếu',
    sortOrder: 2,
  },
  {
    key: 'Ngay_Hoan_Ung',
    label: 'Ngày hoàn ứng',
    group: 'Phiếu',
    sortOrder: 3,
  },
  { key: 'Ngay', label: 'Ngày (dd/mm/yyyy)', group: 'Phiếu', sortOrder: 4 },
  { key: 'Thang', label: 'Tháng', group: 'Phiếu', sortOrder: 5 },
  { key: 'Nam', label: 'Năm', group: 'Phiếu', sortOrder: 6 },
  { key: 'Ky_Tam_Ung', label: 'Kỳ tạm ứng', group: 'Phiếu', sortOrder: 7 },
  {
    key: 'So_Tien_Tam_Ung',
    label: 'Số tiền đã tạm ứng',
    group: 'Phiếu',
    sortOrder: 8,
  },
  {
    key: 'Da_Su_Dung',
    label: 'Đã sử dụng (phiếu chi kho)',
    group: 'Phiếu',
    sortOrder: 9,
  },
  { key: 'So_Tien', label: 'Số tiền hoàn ứng', group: 'Phiếu', sortOrder: 10 },
  {
    key: 'So_Tien_Bang_Chu',
    label: 'Số tiền bằng chữ',
    group: 'Phiếu',
    sortOrder: 11,
  },
  {
    key: 'Noi_Dung',
    label: 'Nội dung hoàn ứng',
    group: 'Phiếu',
    sortOrder: 12,
  },
  { key: 'Trang_Thai', label: 'Trạng thái', group: 'Phiếu', sortOrder: 13 },
  {
    key: 'Nguoi_Hoan_Ung',
    label: 'Người hoàn ứng',
    group: 'Nhân viên',
    sortOrder: 1,
  },
  {
    key: 'Nguoi_Lap',
    label: 'Người lập phiếu',
    group: 'Nhân viên',
    sortOrder: 2,
  },
  {
    key: 'Nguoi_Xac_Nhan',
    label: 'Người xác nhận nhận tiền',
    group: 'Nhân viên',
    sortOrder: 3,
  },
];

const LINE = 'border-bottom:1px dotted #555;padding:3px 6px';
const LABEL = 'white-space:nowrap;padding:3px 6px;width:30%';

const signatures = (cells: Array<[string, string]>) => `
  <table style="width:100%;border-collapse:collapse;margin-top:10px;text-align:center">
    <tr>${cells
      .map(
        ([title]) =>
          `<td style="width:25%;padding:2px"><b>${title}</b><br /><i style="font-size:9pt">(Ký, họ tên)</i></td>`,
      )
      .join('')}</tr>
    <tr>${cells
      .map(
        ([, name]) =>
          `<td style="height:58px;vertical-align:bottom;padding:2px">${name}</td>`,
      )
      .join('')}</tr>
  </table>`;

const voucher = (input: {
  title: string;
  code: string;
  date: string;
  rows: Array<[string, string]>;
  amountLabel: string;
  signatures: Array<[string, string]>;
}) => `<style>@page { size: A5 landscape; margin: 8mm; }</style>
<div style="font-family:'Times New Roman',Times,serif;font-size:11pt;color:#000;border:2px solid #000;padding:10px 14px">
  <table style="width:100%;border-collapse:collapse">
    <tr>
      <td style="width:62%;vertical-align:top;padding:0">
        <b style="font-size:12pt">{Ten_Cua_Hang}</b><br />
        <span style="font-size:9.5pt">{Dia_Chi_Cua_Hang}</span><br />
        <span style="font-size:9.5pt">ĐT: {So_Dien_Thoai_Cua_Hang}</span>
      </td>
      <td style="vertical-align:top;text-align:right;padding:0;font-size:10pt">
        Số: <b>${input.code}</b><br />Ngày: <b>${input.date}</b>
      </td>
    </tr>
  </table>
  <div style="text-align:center;margin:8px 0 6px">
    <div style="font-size:17pt;font-weight:bold;letter-spacing:2px">${input.title}</div>
    <i style="font-size:10pt">Ngày {Ngay}</i>
  </div>
  <table style="width:100%;border-collapse:collapse">
    ${input.rows
      .map(
        ([label, value]) =>
          `<tr><td style="${LABEL}">${label}</td><td style="${LINE}">${value}</td></tr>`,
      )
      .join('\n    ')}
    <tr>
      <td style="${LABEL}">${input.amountLabel}</td>
      <td style="padding:6px">
        <span style="display:inline-block;border:2px solid #000;padding:4px 18px;font-size:15pt;font-weight:bold">{So_Tien} đ</span>
      </td>
    </tr>
    <tr><td style="${LABEL}">Bằng chữ:</td><td style="${LINE}"><i>{So_Tien_Bang_Chu}</i></td></tr>
  </table>
  ${signatures(input.signatures)}
</div>`;

const ADVANCE_TEMPLATE = voucher({
  title: 'PHIẾU CHI TẠM ỨNG',
  code: '{Ma_Phieu_Tam_Ung}',
  date: '{Ngay_Tam_Ung}',
  rows: [
    ['Họ tên người nhận tạm ứng:', '<b>{Nguoi_Tam_Ung}</b>'],
    ['Chi từ quỹ:', '{Kho}'],
    ['Nội dung tạm ứng:', '{Noi_Dung}'],
    ['Kỳ tạm ứng:', '{Ky_Tam_Ung}'],
    ['Hạn làm hoàn ứng:', '{Han_Hoan_Ung}'],
  ],
  amountLabel: 'Số tiền tạm ứng:',
  signatures: [
    ['Người lập phiếu', '{Nguoi_Lap}'],
    ['Kế toán', ''],
    ['Thủ quỹ', ''],
    ['Người nhận tiền', '{Nguoi_Tam_Ung}'],
  ],
});

const REFUND_TEMPLATE = voucher({
  title: 'PHIẾU THU HOÀN ỨNG',
  code: '{Ma_Phieu_Hoan_Ung}',
  date: '{Ngay_Hoan_Ung}',
  rows: [
    ['Họ tên người hoàn ứng:', '<b>{Nguoi_Hoan_Ung}</b>'],
    ['Nộp vào quỹ:', '{Kho}'],
    ['Hoàn cho tạm ứng:', '{Ma_Phieu_Tam_Ung} — {Ky_Tam_Ung}'],
    ['Đã tạm ứng / đã sử dụng:', '{So_Tien_Tam_Ung} đ / {Da_Su_Dung} đ'],
    ['Nội dung:', '{Noi_Dung}'],
  ],
  amountLabel: 'Số tiền hoàn ứng:',
  signatures: [
    ['Người lập phiếu', '{Nguoi_Lap}'],
    ['Kế toán', ''],
    ['Thủ quỹ', ''],
    ['Người nộp tiền', '{Nguoi_Hoan_Ung}'],
  ],
});

const TEMPLATES = [
  {
    templateFor: 'cash_advance',
    code: 'TU_DEFAULT',
    name: 'Phiếu tạm ứng',
    content: ADVANCE_TEMPLATE,
    variables: ADVANCE_VARIABLES,
  },
  {
    templateFor: 'cash_advance_refund',
    code: 'HU_DEFAULT',
    name: 'Phiếu hoàn ứng',
    content: REFUND_TEMPLATE,
    variables: REFUND_VARIABLES,
  },
];

async function main() {
  console.log('🌱 Seeding mẫu in Phiếu tạm ứng / Phiếu hoàn ứng...');
  for (const template of TEMPLATES) {
    for (const v of template.variables) {
      await prisma.printTemplateVariable.upsert({
        where: {
          templateFor_key: { templateFor: template.templateFor, key: v.key },
        },
        update: {
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: false,
        },
        create: {
          templateFor: template.templateFor,
          key: v.key,
          label: v.label,
          group: v.group,
          sortOrder: v.sortOrder,
          isItemVariable: false,
        },
      });
    }
    console.log(
      `  ✅ ${template.templateFor}: upserted ${template.variables.length} variables`,
    );
  }

  // Reset sequence id của print_templates để tránh xung đột id khi insert.
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('print_templates', 'id'),
      COALESCE((SELECT MAX(id) FROM print_templates), 0) + 1,
      false
    )
  `);

  const admin =
    (await prisma.user.findFirst({
      where: { email: { contains: 'admin' } },
    })) || (await prisma.user.findFirst());
  if (!admin) {
    console.log(
      '⚠️  Không tìm thấy user nào để gán createdBy — bỏ qua template.',
    );
    return;
  }

  for (const template of TEMPLATES) {
    // update: {} — không ghi đè mẫu người dùng đã chỉnh trên UI khi re-run.
    await prisma.printTemplate.upsert({
      where: {
        templateFor_code: {
          templateFor: template.templateFor,
          code: template.code,
        },
      },
      update: {},
      create: {
        name: template.name,
        code: template.code,
        templateFor: template.templateFor,
        content: template.content,
        paperSize: 'A5',
        orientation: 'landscape',
        isActive: true,
        isDefault: true,
        createdBy: admin.id,
      },
    });
    console.log(`  ✅ Upserted template ${template.code}`);
  }
  console.log('🎉 Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
