import { BuiltinPrintVariable } from './production-external-print';

/**
 * Mẫu in "Phiếu nguyên liệu tại NSX" (gửi trước cho NSX dùng dần / NSX trả về /
 * điều chỉnh tồn tại NSX). Phiếu đi kèm hàng nên KHÔNG có biến tiền nào:
 * không giá vốn, không giá trị phiếu. Biến và mẫu mặc định nằm trong code.
 */
export const MANUFACTURER_STOCK = 'manufacturer_stock';

const GROUP_STORE = 'Cửa hàng';
const GROUP_SLIP = 'Phiếu nguyên liệu';
const GROUP_MANUFACTURER = 'Nhà sản xuất';
const GROUP_ITEMS = 'Nguyên liệu';

export const MANUFACTURER_STOCK_VARIABLES: BuiltinPrintVariable[] = [
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng (kho của phiếu)', group: GROUP_STORE, sortOrder: 1, isItemVariable: false },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ kho', group: GROUP_STORE, sortOrder: 2, isItemVariable: false },
  { key: 'So_Dien_Thoai_Cua_Hang', label: 'SĐT kho', group: GROUP_STORE, sortOrder: 3, isItemVariable: false },
  { key: 'Tieu_De', label: 'Tiêu đề theo loại phiếu', group: GROUP_SLIP, sortOrder: 1, isItemVariable: false },
  { key: 'Ma_Phieu', label: 'Mã phiếu', group: GROUP_SLIP, sortOrder: 2, isItemVariable: false },
  { key: 'Loai_Phieu', label: 'Loại phiếu (Gửi / Trả / Điều chỉnh / Tồn đầu)', group: GROUP_SLIP, sortOrder: 3, isItemVariable: false },
  { key: 'Trang_Thai', label: 'Trạng thái phiếu', group: GROUP_SLIP, sortOrder: 4, isItemVariable: false },
  { key: 'Ngay_Phieu', label: 'Ngày phiếu (dd/mm/yyyy)', group: GROUP_SLIP, sortOrder: 5, isItemVariable: false },
  { key: 'Ngay', label: 'Ngày', group: GROUP_SLIP, sortOrder: 6, isItemVariable: false },
  { key: 'Thang', label: 'Tháng', group: GROUP_SLIP, sortOrder: 7, isItemVariable: false },
  { key: 'Nam', label: 'Năm', group: GROUP_SLIP, sortOrder: 8, isItemVariable: false },
  { key: 'Kho', label: 'Kho gửi / kho nhận', group: GROUP_SLIP, sortOrder: 9, isItemVariable: false },
  { key: 'Nguoi_Lap', label: 'Người lập phiếu', group: GROUP_SLIP, sortOrder: 10, isItemVariable: false },
  { key: 'Ghi_Chu', label: 'Ghi chú', group: GROUP_SLIP, sortOrder: 11, isItemVariable: false },
  { key: 'Tong_So_Mat_Hang', label: 'Số dòng nguyên liệu', group: GROUP_SLIP, sortOrder: 12, isItemVariable: false },
  { key: 'Cot_So_Luong', label: 'Tên cột lượng (Lượng gửi / Lượng trả / Thực tế còn)', group: GROUP_SLIP, sortOrder: 13, isItemVariable: false },
  { key: 'Cot_Quy_Doi', label: 'Tên cột quy đổi (Quy đổi kho / Chênh lệch)', group: GROUP_SLIP, sortOrder: 14, isItemVariable: false },
  { key: 'Ben_Giao', label: 'Bên giao (ký nhận)', group: GROUP_SLIP, sortOrder: 15, isItemVariable: false },
  { key: 'Ben_Nhan', label: 'Bên nhận (ký nhận)', group: GROUP_SLIP, sortOrder: 16, isItemVariable: false },
  { key: 'Ma_Nha_San_Xuat', label: 'Mã nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 1, isItemVariable: false },
  { key: 'Nha_San_Xuat', label: 'Tên nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 2, isItemVariable: false },
  { key: 'Dien_Thoai_Nha_San_Xuat', label: 'SĐT nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 3, isItemVariable: false },
  { key: 'Dia_Chi_Nha_San_Xuat', label: 'Địa chỉ nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 4, isItemVariable: false },
  { key: 'STT', label: 'STT', group: GROUP_ITEMS, sortOrder: 1, isItemVariable: true },
  { key: 'Ma_Hang', label: 'Mã hàng', group: GROUP_ITEMS, sortOrder: 2, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng', group: GROUP_ITEMS, sortOrder: 3, isItemVariable: true },
  { key: 'So_Luong', label: 'Lượng (gửi / trả / thực tế còn)', group: GROUP_ITEMS, sortOrder: 4, isItemVariable: true },
  { key: 'Don_Vi', label: 'Đơn vị lượng (g, kg, …)', group: GROUP_ITEMS, sortOrder: 5, isItemVariable: true },
  { key: 'Quy_Doi', label: 'Quy đổi đơn vị kho (Điều chỉnh: chênh lệch)', group: GROUP_ITEMS, sortOrder: 6, isItemVariable: true },
  { key: 'Don_Vi_Kho', label: 'Đơn vị kho', group: GROUP_ITEMS, sortOrder: 7, isItemVariable: true },
  { key: 'Ton_He_Thong', label: 'Tồn hệ thống tại NSX (Điều chỉnh)', group: GROUP_ITEMS, sortOrder: 8, isItemVariable: true },
];

export const MANUFACTURER_STOCK_ITEM_KEYS = MANUFACTURER_STOCK_VARIABLES
  .filter((item) => item.isItemVariable)
  .map((item) => item.key);

const cell = 'border: 1px solid #000; padding: 4px;';

export const MANUFACTURER_STOCK_DEFAULT_TEMPLATE = `<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px;">
<div style="text-align: center;">
<div style="font-weight: bold;">{Ten_Cua_Hang}</div>
<div>{Dia_Chi_Cua_Hang}</div>
<h2 style="margin: 8px 0 2px;">{Tieu_De}</h2>
<div>Mã phiếu: <strong>{Ma_Phieu}</strong> &middot; Ngày: {Ngay_Phieu}</div>
</div>
<hr>
<table style="width: 100%; border-collapse: collapse;" cellspacing="0" cellpadding="2">
<tbody>
<tr><td style="width: 32%;">Nhà sản xuất:</td><td><strong>{Nha_San_Xuat}</strong> ({Ma_Nha_San_Xuat})</td></tr>
<tr><td>Điện thoại / địa chỉ:</td><td>{Dien_Thoai_Nha_San_Xuat} &middot; {Dia_Chi_Nha_San_Xuat}</td></tr>
<tr><td>Kho:</td><td>{Kho}</td></tr>
</tbody>
</table>
<div style="margin-top: 8px; font-weight: bold;">Nguyên liệu ({Tong_So_Mat_Hang} dòng)</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 4px;" cellspacing="0" cellpadding="4">
<thead>
<tr>
<th style="${cell} width: 6%;">STT</th>
<th style="${cell} width: 16%; text-align: left;">Mã hàng</th>
<th style="${cell} text-align: left;">Tên hàng</th>
<th style="${cell} width: 20%;">{Cot_So_Luong}</th>
<th style="${cell} width: 20%;">{Cot_Quy_Doi}</th>
</tr>
</thead>
<tbody>
<tr>
<td style="${cell} text-align: center;">{STT}</td>
<td style="${cell}">{Ma_Hang}</td>
<td style="${cell}">{Ten_Hang_Hoa}</td>
<td style="${cell} text-align: center;">{So_Luong} {Don_Vi}</td>
<td style="${cell} text-align: center;">{Quy_Doi} {Don_Vi_Kho}</td>
</tr>
</tbody>
</table>
<div style="margin-top: 8px;">Ghi chú: {Ghi_Chu}</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 20px; text-align: center;" cellspacing="0" cellpadding="4">
<tbody>
<tr>
<td style="width: 33%;"><strong>Người lập phiếu</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
<td style="width: 33%;"><strong>{Ben_Giao}</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
<td style="width: 34%;"><strong>{Ben_Nhan}</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
</tr>
<tr>
<td style="padding-top: 48px;">{Nguoi_Lap}</td>
<td style="padding-top: 48px;"></td>
<td style="padding-top: 48px;"></td>
</tr>
</tbody>
</table>
</div>`;

const TYPE_TEXT: Record<string, {
  label: string; title: string; quantity: string; converted: string; giver: string; receiver: string;
}> = {
  SEND: {
    label: 'Gửi nguyên liệu', title: 'PHIẾU GỬI NGUYÊN LIỆU CHO NHÀ SẢN XUẤT',
    quantity: 'Lượng gửi', converted: 'Quy đổi kho', giver: 'Người giao hàng', receiver: 'Nhà sản xuất nhận',
  },
  RETURN: {
    label: 'Trả nguyên liệu', title: 'PHIẾU NHẬN LẠI NGUYÊN LIỆU TỪ NHÀ SẢN XUẤT',
    quantity: 'Lượng trả', converted: 'Quy đổi kho', giver: 'Nhà sản xuất giao', receiver: 'Người nhận hàng',
  },
  ADJUST: {
    label: 'Điều chỉnh tồn', title: 'PHIẾU ĐIỀU CHỈNH TỒN NGUYÊN LIỆU TẠI NHÀ SẢN XUẤT',
    quantity: 'Thực tế còn', converted: 'Chênh lệch', giver: 'Đại diện nhà sản xuất', receiver: 'Người kiểm',
  },
  OPENING: {
    label: 'Khai báo tồn đầu', title: 'PHIẾU KHAI BÁO TỒN NGUYÊN LIỆU TẠI NHÀ SẢN XUẤT',
    quantity: 'Lượng đang ở NSX', converted: 'Quy đổi kho', giver: 'Đại diện nhà sản xuất', receiver: 'Người xác nhận',
  },
};

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const qty = (value: unknown) =>
  value == null || value === '' ? '' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 4 });

/** Chênh lệch có dấu: +0.5 / −0.25 / 0. */
const signed = (value: unknown) => {
  const n = Number(value ?? 0);
  return n > 0 ? `+${qty(n)}` : n < 0 ? `−${qty(-n)}` : '0';
};

const ddmmyyyy = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
};

/** Dữ liệu in phiếu nguyên liệu NSX — cố ý không trả về giá vốn hay giá trị phiếu. */
export function mapManufacturerStock(slip: any) {
  const text = TYPE_TEXT[slip.type] ?? TYPE_TEXT.SEND;
  const adjust = slip.type === 'ADJUST';
  const date = slip.date ? new Date(slip.date) : null;
  const lines = slip.lines ?? [];
  return {
    Ten_Cua_Hang: escapeHtml(slip.branch?.name || slip.branchName),
    Dia_Chi_Cua_Hang: escapeHtml(slip.branch?.address),
    So_Dien_Thoai_Cua_Hang: escapeHtml(slip.branch?.contactNumber),
    Tieu_De: text.title,
    Ma_Phieu: escapeHtml(slip.code),
    Loai_Phieu: text.label,
    Trang_Thai: slip.status === 2 ? 'Đã hủy' : 'Hiệu lực',
    Ngay_Phieu: ddmmyyyy(date),
    Ngay: date ? ddmmyyyy(date) : '',
    Thang: date ? String(date.getMonth() + 1) : '',
    Nam: date ? String(date.getFullYear()) : '',
    Kho: escapeHtml(slip.branchName || slip.branch?.name || (adjust || slip.type === 'OPENING' ? 'Tồn tại nhà sản xuất' : '')),
    Nguoi_Lap: escapeHtml(slip.createdByName),
    Ghi_Chu: slip.note || '',
    Tong_So_Mat_Hang: String(lines.length),
    Cot_So_Luong: text.quantity,
    Cot_Quy_Doi: text.converted,
    Ben_Giao: text.giver,
    Ben_Nhan: text.receiver,
    Ma_Nha_San_Xuat: escapeHtml(slip.manufacturer?.code),
    Nha_San_Xuat: escapeHtml(slip.manufacturer?.name),
    Dien_Thoai_Nha_San_Xuat: escapeHtml(slip.manufacturer?.contactNumber),
    Dia_Chi_Nha_San_Xuat: escapeHtml(slip.manufacturer?.address),
    items: lines.map((line: any, index: number) => ({
      STT: String(index + 1),
      Ma_Hang: escapeHtml(line.productCode),
      Ten_Hang_Hoa: escapeHtml(line.productName),
      So_Luong: qty(line.quantity),
      Don_Vi: escapeHtml(line.unit === 'unit' ? line.product?.unit : line.unit),
      Quy_Doi: adjust ? signed(line.units) : qty(Math.abs(Number(line.units ?? 0))),
      Don_Vi_Kho: escapeHtml(line.product?.unit),
      Ton_He_Thong: adjust ? qty(line.systemUnits) : '',
    })),
  };
}
