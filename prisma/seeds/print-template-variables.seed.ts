import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const VARIABLES = [
  // Thông tin cơ bản
  {
    templateFor: 'invoice',
    key: 'Ma_Don_Hang',
    label: 'Mã đơn hàng',
    group: 'Thông tin cơ bản',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Ngay',
    label: 'Ngày',
    group: 'Thông tin cơ bản',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Khu_Vuc_Chi_Nhanh_QH_TP',
    label: 'Khu vực chi nhánh',
    group: 'Thông tin cơ bản',
    sortOrder: 3,
    isItemVariable: false,
  },

  // Khách hàng
  {
    templateFor: 'invoice',
    key: 'Ma_Khach_Hang',
    label: 'Mã khách hàng',
    group: 'Khách hàng',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Khach_Hang',
    label: 'Tên khách hàng',
    group: 'Khách hàng',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'So_Dien_Thoai',
    label: 'Số điện thoại',
    group: 'Khách hàng',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Dia_Chi_Khach_Hang',
    label: 'Địa chỉ',
    group: 'Khách hàng',
    sortOrder: 4,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Phuong_Xa_Khach_Hang',
    label: 'Phường/Xã',
    group: 'Khách hàng',
    sortOrder: 5,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Khu_Vuc_Khach_Hang_QH_TP',
    label: 'Quận/Huyện',
    group: 'Khách hàng',
    sortOrder: 6,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Ghi_Chu_Khach_Hang',
    label: 'Ghi chú khách hàng',
    group: 'Khách hàng',
    sortOrder: 7,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Ghi_Chu',
    label: 'Ghi chú đơn hàng',
    group: 'Khách hàng',
    sortOrder: 8,
    isItemVariable: false,
  },

  // Nhân viên
  {
    templateFor: 'invoice',
    key: 'Nhan_Vien_Ban_Hang',
    label: 'Nhân viên bán hàng',
    group: 'Nhân viên',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Dien_Thoai_Nguoi_Ban',
    label: 'Điện thoại người bán',
    group: 'Nhân viên',
    sortOrder: 2,
    isItemVariable: false,
  },

  // Sản phẩm (Item Variables)
  {
    templateFor: 'invoice',
    key: 'Ten_Hang_Hoa',
    label: 'Tên hàng hóa',
    group: 'Sản phẩm',
    sortOrder: 1,
    isItemVariable: true,
  },
  {
    templateFor: 'invoice',
    key: 'Ma_Hang_Hoa',
    label: 'Mã hàng hóa',
    group: 'Sản phẩm',
    sortOrder: 2,
    isItemVariable: true,
  },
  {
    templateFor: 'invoice',
    key: 'So_Luong',
    label: 'Số lượng',
    group: 'Sản phẩm',
    sortOrder: 3,
    isItemVariable: true,
  },
  {
    templateFor: 'invoice',
    key: 'Don_Gia',
    label: 'Đơn giá',
    group: 'Sản phẩm',
    sortOrder: 4,
    isItemVariable: true,
  },
  {
    templateFor: 'invoice',
    key: 'Thanh_Tien',
    label: 'Thành tiền',
    group: 'Sản phẩm',
    sortOrder: 5,
    isItemVariable: true,
  },
  {
    templateFor: 'invoice',
    key: 'Ghi_Chu_Hang_Hoa',
    label: 'Ghi chú',
    group: 'Sản phẩm',
    sortOrder: 6,
    isItemVariable: true,
  },

  // Tổng tiền
  {
    templateFor: 'invoice',
    key: 'Tong_Tien_Hang',
    label: 'Tổng tiền hàng',
    group: 'Tổng tiền',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Chiet_Khau_Hoa_Don_Phan_Tram',
    label: 'Chiết khấu (%)',
    group: 'Tổng tiền',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Chiet_Khau_Hoa_Don',
    label: 'Chiết khấu',
    group: 'Tổng tiền',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Da_Thanh_Toan_Ten_Phuong_Thuc_Ttoan',
    label: 'Đã thanh toán',
    group: 'Tổng tiền',
    sortOrder: 4,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Can_Thanh_Toan',
    label: 'Còn thanh toán',
    group: 'Tổng tiền',
    sortOrder: 5,
    isItemVariable: false,
  },
  {
    templateFor: 'invoice',
    key: 'Tong_Can_Thanh_Toan_Bang_Chu',
    label: 'Tổng tiền (bằng chữ)',
    group: 'Tổng tiền',
    sortOrder: 6,
    isItemVariable: false,
  },
  // ==================== PHIẾU GIAO HÀNG ====================

  // Thông tin cơ bản
  {
    templateFor: 'delivery',
    key: 'Ma_Don_Hang',
    label: 'Mã đặt hàng',
    group: 'Thông tin cơ bản',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Ma_Hoa_Don',
    label: 'Mã hóa đơn',
    group: 'Thông tin cơ bản',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Ngay',
    label: 'Ngày',
    group: 'Thông tin cơ bản',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Thang',
    label: 'Tháng',
    group: 'Thông tin cơ bản',
    sortOrder: 4,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Nam',
    label: 'Năm',
    group: 'Thông tin cơ bản',
    sortOrder: 5,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Ghi_Chu',
    label: 'Ghi chú đơn',
    group: 'Thông tin cơ bản',
    sortOrder: 6,
    isItemVariable: false,
  },

  // Cửa hàng
  {
    templateFor: 'delivery',
    key: 'Ten_Cua_Hang',
    label: 'Tên cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Dia_Chi_Cua_Hang',
    label: 'Địa chỉ cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'So_Dien_Thoai_Cua_Hang',
    label: 'SĐT cửa hàng',
    group: 'Cửa hàng',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Chi_Nhanh_Ban_Hang',
    label: 'Chi nhánh',
    group: 'Cửa hàng',
    sortOrder: 4,
    isItemVariable: false,
  },

  // Khách hàng
  {
    templateFor: 'delivery',
    key: 'Ma_Khach_Hang',
    label: 'Mã khách hàng',
    group: 'Khách hàng',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Khach_Hang',
    label: 'Tên khách hàng',
    group: 'Khách hàng',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'So_Dien_Thoai',
    label: 'SĐT khách hàng',
    group: 'Khách hàng',
    sortOrder: 3,
    isItemVariable: false,
  },

  // Giao hàng
  {
    templateFor: 'delivery',
    key: 'Nguoi_Nhan',
    label: 'Người nhận',
    group: 'Giao hàng',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Dien_Thoai_Nhan',
    label: 'SĐT người nhận',
    group: 'Giao hàng',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Dia_Chi_Giao_Hang',
    label: 'Địa chỉ giao hàng',
    group: 'Giao hàng',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Phuong_Xa_Giao_Hang',
    label: 'Phường/Xã',
    group: 'Giao hàng',
    sortOrder: 4,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Khu_Vuc_Giao_Hang',
    label: 'Khu vực (Quận - Tỉnh/TP)',
    group: 'Giao hàng',
    sortOrder: 5,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Ghi_Chu_Giao_Hang',
    label: 'Ghi chú giao hàng',
    group: 'Giao hàng',
    sortOrder: 6,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Trang_Thai_Giao_Hang',
    label: 'Trạng thái giao hàng',
    group: 'Giao hàng',
    sortOrder: 7,
    isItemVariable: false,
  },

  // Nhân viên
  {
    templateFor: 'delivery',
    key: 'Nhan_Vien_Ban_Hang',
    label: 'Nhân viên bán hàng',
    group: 'Nhân viên',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Dien_Thoai_Nguoi_Ban',
    label: 'Điện thoại người bán',
    group: 'Nhân viên',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Nguoi_Lap',
    label: 'Người lập',
    group: 'Nhân viên',
    sortOrder: 3,
    isItemVariable: false,
  },

  // Tổng tiền
  {
    templateFor: 'delivery',
    key: 'Tong_Tien_Hang',
    label: 'Tổng tiền hàng',
    group: 'Tổng tiền',
    sortOrder: 1,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Giam_Gia',
    label: 'Giảm giá',
    group: 'Tổng tiền',
    sortOrder: 2,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Tong_Can_Thanh_Toan',
    label: 'Tổng cần thanh toán',
    group: 'Tổng tiền',
    sortOrder: 3,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Da_Thanh_Toan',
    label: 'Đã thanh toán',
    group: 'Tổng tiền',
    sortOrder: 4,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Con_Lai',
    label: 'Còn lại',
    group: 'Tổng tiền',
    sortOrder: 5,
    isItemVariable: false,
  },
  {
    templateFor: 'delivery',
    key: 'Tong_Can_Thanh_Toan_Bang_Chu',
    label: 'Tổng tiền (bằng chữ)',
    group: 'Tổng tiền',
    sortOrder: 6,
    isItemVariable: false,
  },

  // Sản phẩm (item variables)
  {
    templateFor: 'delivery',
    key: 'Ma_Hang',
    label: 'Mã hàng',
    group: 'Sản phẩm',
    sortOrder: 1,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'Ten_Hang_Hoa',
    label: 'Tên hàng hóa',
    group: 'Sản phẩm',
    sortOrder: 2,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'Don_Vi_Tinh',
    label: 'Đơn vị tính',
    group: 'Sản phẩm',
    sortOrder: 3,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'So_Luong',
    label: 'Số lượng',
    group: 'Sản phẩm',
    sortOrder: 4,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'Don_Gia',
    label: 'Đơn giá',
    group: 'Sản phẩm',
    sortOrder: 5,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'Thanh_Tien',
    label: 'Thành tiền',
    group: 'Sản phẩm',
    sortOrder: 6,
    isItemVariable: true,
  },
  {
    templateFor: 'delivery',
    key: 'Ghi_Chu_Hang_Hoa',
    label: 'Ghi chú hàng',
    group: 'Sản phẩm',
    sortOrder: 7,
    isItemVariable: true,
  },
];

async function seedPrintTemplateVariables() {
  console.log('Seeding print template variables...');

  for (const variable of VARIABLES) {
    await prisma.printTemplateVariable.upsert({
      where: {
        templateFor_key: {
          templateFor: variable.templateFor,
          key: variable.key,
        },
      },
      update: {
        isItemVariable: variable.isItemVariable,
      },
      create: variable,
    });
  }

  console.log('Print template variables seeded');
}

seedPrintTemplateVariables()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
