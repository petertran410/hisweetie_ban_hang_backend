import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface VarDef {
  key: string;
  label: string;
  group: string;
  dataType?: string;
  description?: string;
  isItemVariable?: boolean;
  sortOrder?: number;
}

const STORE_VARS: VarDef[] = [
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
    label: 'Số điện thoại cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 3,
  },
  {
    key: 'Chi_Nhanh_Ban_Hang',
    label: 'Chi nhánh',
    group: 'Chi nhánh',
    sortOrder: 10,
  },
];

const DATE_VARS: VarDef[] = [
  {
    key: 'Ngay',
    label: 'Ngày',
    group: 'Thời gian',
    dataType: 'date',
    sortOrder: 20,
  },
  {
    key: 'Thang',
    label: 'Tháng',
    group: 'Thời gian',
    dataType: 'number',
    sortOrder: 21,
  },
  {
    key: 'Nam',
    label: 'Năm',
    group: 'Thời gian',
    dataType: 'number',
    sortOrder: 22,
  },
];

const CUSTOMER_VARS: VarDef[] = [
  {
    key: 'Ma_Khach_Hang',
    label: 'Mã khách hàng',
    group: 'Khách hàng',
    sortOrder: 30,
  },
  {
    key: 'Khach_Hang',
    label: 'Tên khách hàng',
    group: 'Khách hàng',
    sortOrder: 31,
  },
  {
    key: 'So_Dien_Thoai',
    label: 'Số điện thoại',
    group: 'Khách hàng',
    sortOrder: 32,
  },
  {
    key: 'Dia_Chi_Khach_Hang',
    label: 'Địa chỉ khách hàng',
    group: 'Khách hàng',
    sortOrder: 33,
  },
  {
    key: 'Ghi_Chu_Khach_Hang',
    label: 'Ghi chú khách hàng',
    group: 'Khách hàng',
    sortOrder: 34,
  },
];

const SUPPLIER_VARS: VarDef[] = [
  {
    key: 'Ma_Nha_Cung_Cap',
    label: 'Mã NCC',
    group: 'Nhà cung cấp',
    sortOrder: 30,
  },
  {
    key: 'Ten_Nha_Cung_Cap',
    label: 'Tên NCC',
    group: 'Nhà cung cấp',
    sortOrder: 31,
  },
  {
    key: 'So_Dien_Thoai_NCC',
    label: 'SĐT NCC',
    group: 'Nhà cung cấp',
    sortOrder: 32,
  },
  {
    key: 'Dia_Chi_NCC',
    label: 'Địa chỉ NCC',
    group: 'Nhà cung cấp',
    sortOrder: 33,
  },
];

const STAFF_VARS: VarDef[] = [
  {
    key: 'Nhan_Vien_Ban_Hang',
    label: 'Nhân viên bán hàng',
    group: 'Nhân viên',
    sortOrder: 40,
  },
  { key: 'Nguoi_Lap', label: 'Người lập', group: 'Nhân viên', sortOrder: 41 },
];

const NOTE_VARS: VarDef[] = [
  { key: 'Ghi_Chu', label: 'Ghi chú', group: 'Ghi chú', sortOrder: 50 },
];

const MONEY_VARS: VarDef[] = [
  {
    key: 'Tong_Tien_Hang',
    label: 'Tổng tiền hàng',
    group: 'Thanh toán',
    dataType: 'money',
    sortOrder: 60,
  },
  {
    key: 'Chiet_Khau_Hoa_Don',
    label: 'Chiết khấu',
    group: 'Thanh toán',
    dataType: 'money',
    sortOrder: 61,
  },
  {
    key: 'Tong_Can_Thanh_Toan',
    label: 'Cần thanh toán',
    group: 'Thanh toán',
    dataType: 'money',
    sortOrder: 62,
  },
  {
    key: 'Da_Thanh_Toan',
    label: 'Đã thanh toán',
    group: 'Thanh toán',
    dataType: 'money',
    sortOrder: 63,
  },
  {
    key: 'Con_Lai',
    label: 'Còn lại',
    group: 'Thanh toán',
    dataType: 'money',
    sortOrder: 64,
  },
  {
    key: 'Tong_Can_Thanh_Toan_Bang_Chu',
    label: 'Thành tiền bằng chữ',
    group: 'Thanh toán',
    sortOrder: 65,
  },
];

const ITEM_VARS: VarDef[] = [
  {
    key: 'Ma_Hang',
    label: 'Mã hàng',
    group: 'Hàng hóa',
    isItemVariable: true,
    sortOrder: 70,
  },
  {
    key: 'Ten_Hang_Hoa',
    label: 'Tên hàng hóa',
    group: 'Hàng hóa',
    isItemVariable: true,
    sortOrder: 71,
  },
  {
    key: 'Don_Vi_Tinh',
    label: 'Đơn vị tính',
    group: 'Hàng hóa',
    isItemVariable: true,
    sortOrder: 72,
  },
  {
    key: 'So_Luong',
    label: 'Số lượng',
    group: 'Hàng hóa',
    dataType: 'number',
    isItemVariable: true,
    sortOrder: 73,
  },
  {
    key: 'Don_Gia',
    label: 'Đơn giá',
    group: 'Hàng hóa',
    dataType: 'money',
    isItemVariable: true,
    sortOrder: 74,
  },
  {
    key: 'Don_Gia_Sau_Chiet_Khau',
    label: 'Đơn giá sau CK',
    group: 'Hàng hóa',
    dataType: 'money',
    isItemVariable: true,
    sortOrder: 75,
  },
  {
    key: 'Ghi_Chu_Hang_Hoa',
    label: 'Ghi chú hàng',
    group: 'Hàng hóa',
    isItemVariable: true,
    sortOrder: 76,
  },
  {
    key: 'Thanh_Tien',
    label: 'Thành tiền',
    group: 'Hàng hóa',
    dataType: 'money',
    isItemVariable: true,
    sortOrder: 77,
  },
];

const TEMPLATE_VARS: Record<string, VarDef[]> = {
  invoice: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Don_Hang',
      label: 'Mã hóa đơn',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    ...CUSTOMER_VARS,
    ...STAFF_VARS,
    ...NOTE_VARS,
    ...MONEY_VARS,
    ...ITEM_VARS,
  ],
  order: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Don_Hang',
      label: 'Mã đơn đặt hàng',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    ...CUSTOMER_VARS,
    ...STAFF_VARS,
    ...NOTE_VARS,
    ...MONEY_VARS,
    ...ITEM_VARS,
  ],
  order_supplier: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Dat_Hang_Nhap',
      label: 'Mã đặt hàng nhập',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    ...SUPPLIER_VARS,
    ...STAFF_VARS,
    ...NOTE_VARS,
    ...MONEY_VARS,
    ...ITEM_VARS,
  ],
  purchase_order: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Nhap_Hang',
      label: 'Mã nhập hàng',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    ...SUPPLIER_VARS,
    ...STAFF_VARS,
    ...NOTE_VARS,
    ...MONEY_VARS,
    ...ITEM_VARS,
  ],
  return_order: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Tra_Hang',
      label: 'Mã trả hàng',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    {
      key: 'Ma_Don_Hang_Goc',
      label: 'Mã hóa đơn gốc',
      group: 'Chứng từ',
      sortOrder: 6,
    },
    ...CUSTOMER_VARS,
    ...STAFF_VARS,
    ...NOTE_VARS,
    {
      key: 'Tong_Tien_Tra',
      label: 'Tổng tiền trả',
      group: 'Thanh toán',
      dataType: 'money',
      sortOrder: 60,
    },
    {
      key: 'Da_Hoan_Tra',
      label: 'Đã hoàn trả',
      group: 'Thanh toán',
      dataType: 'money',
      sortOrder: 61,
    },
    ...ITEM_VARS,
  ],
  transfer: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Chuyen_Hang',
      label: 'Mã chuyển hàng',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    {
      key: 'Chi_Nhanh_Nguon',
      label: 'Chi nhánh gửi',
      group: 'Chi nhánh',
      sortOrder: 10,
    },
    {
      key: 'Chi_Nhanh_Dich',
      label: 'Chi nhánh nhận',
      group: 'Chi nhánh',
      sortOrder: 11,
    },
    ...STAFF_VARS,
    ...NOTE_VARS,
    {
      key: 'Tong_Tien_Chuyen',
      label: 'Tổng tiền chuyển',
      group: 'Thanh toán',
      dataType: 'money',
      sortOrder: 60,
    },
    ...ITEM_VARS,
  ],
  cash_flow_receipt: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Phieu_Thu',
      label: 'Mã phiếu thu',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    { key: 'Nguoi_Nop', label: 'Người nộp', group: 'Đối tác', sortOrder: 30 },
    {
      key: 'Dia_Chi_Nguoi_Nop',
      label: 'Địa chỉ',
      group: 'Đối tác',
      sortOrder: 31,
    },
    ...STAFF_VARS,
    { key: 'Ly_Do_Thu', label: 'Lý do thu', group: 'Nội dung', sortOrder: 50 },
    {
      key: 'So_Tien',
      label: 'Số tiền',
      group: 'Thanh toán',
      dataType: 'money',
      sortOrder: 60,
    },
    {
      key: 'So_Tien_Bang_Chu',
      label: 'Số tiền bằng chữ',
      group: 'Thanh toán',
      sortOrder: 61,
    },
  ],
  cash_flow_payment: [
    ...STORE_VARS,
    ...DATE_VARS,
    {
      key: 'Ma_Phieu_Chi',
      label: 'Mã phiếu chi',
      group: 'Chứng từ',
      sortOrder: 5,
    },
    { key: 'Nguoi_Nhan', label: 'Người nhận', group: 'Đối tác', sortOrder: 30 },
    {
      key: 'Dia_Chi_Nguoi_Nhan',
      label: 'Địa chỉ',
      group: 'Đối tác',
      sortOrder: 31,
    },
    ...STAFF_VARS,
    { key: 'Ly_Do_Chi', label: 'Lý do chi', group: 'Nội dung', sortOrder: 50 },
    {
      key: 'So_Tien',
      label: 'Số tiền',
      group: 'Thanh toán',
      dataType: 'money',
      sortOrder: 60,
    },
    {
      key: 'So_Tien_Bang_Chu',
      label: 'Số tiền bằng chữ',
      group: 'Thanh toán',
      sortOrder: 61,
    },
  ],
};

async function seedPrintTemplateVariables() {
  for (const [templateFor, vars] of Object.entries(TEMPLATE_VARS)) {
    for (const v of vars) {
      await prisma.printTemplateVariable.upsert({
        where: { templateFor_key: { templateFor, key: v.key } },
        update: {
          label: v.label,
          group: v.group,
          dataType: v.dataType || 'string',
          description: v.description,
          isItemVariable: v.isItemVariable || false,
          sortOrder: v.sortOrder || 0,
        },
        create: {
          templateFor,
          key: v.key,
          label: v.label,
          group: v.group,
          dataType: v.dataType || 'string',
          description: v.description,
          isItemVariable: v.isItemVariable || false,
          sortOrder: v.sortOrder || 0,
        },
      });
    }
  }
  console.log('✅ Seeded print template variables');
}

async function main() {
  await seedPrintTemplateVariables();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
