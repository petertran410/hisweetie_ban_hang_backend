/**
 * Mẫu in "Phiếu gửi sản xuất" (phiếu gửi NSX — Production có manufacturerId).
 *
 * Phiếu này đi kèm hàng giao cho nhà sản xuất nên KHÔNG có bất kỳ biến tiền
 * nào: không giá vốn hàng mình gửi, không đơn giá / thành tiền nguyên liệu
 * NSX, không phí gia công, không công nợ. Cũng không in thành phẩm, sản lượng
 * dự kiến và công thức. Chỉ hàng gửi đi (lượng, đơn vị) và thông tin phiếu.
 *
 * Biến và mẫu mặc định nằm trong code (không cần chạy seed): biến được gộp vào
 * danh sách biến lấy từ DB, mẫu mặc định được tạo một lần khi mở danh sách mẫu
 * của loại này mà chưa có mẫu nào.
 */
export const PRODUCTION_EXTERNAL = 'production_external';

export interface BuiltinPrintVariable {
  key: string;
  label: string;
  group: string;
  sortOrder: number;
  isItemVariable: boolean;
  description?: string;
}

const GROUP_STORE = 'Cửa hàng';
const GROUP_SLIP = 'Phiếu gửi';
const GROUP_MANUFACTURER = 'Nhà sản xuất';
const GROUP_ITEMS = 'Hàng mình gửi';

export const PRODUCTION_EXTERNAL_VARIABLES: BuiltinPrintVariable[] = [
  { key: 'Ten_Cua_Hang', label: 'Tên cửa hàng (kho gửi)', group: GROUP_STORE, sortOrder: 1, isItemVariable: false },
  { key: 'Dia_Chi_Cua_Hang', label: 'Địa chỉ kho gửi', group: GROUP_STORE, sortOrder: 2, isItemVariable: false },
  { key: 'So_Dien_Thoai_Cua_Hang', label: 'SĐT kho gửi', group: GROUP_STORE, sortOrder: 3, isItemVariable: false },
  { key: 'Ma_Phieu_Gui', label: 'Mã phiếu gửi', group: GROUP_SLIP, sortOrder: 1, isItemVariable: false },
  { key: 'Trang_Thai', label: 'Trạng thái phiếu', group: GROUP_SLIP, sortOrder: 2, isItemVariable: false },
  { key: 'Ngay_Gui', label: 'Ngày gửi (dd/mm/yyyy)', group: GROUP_SLIP, sortOrder: 3, isItemVariable: false },
  { key: 'Ngay', label: 'Ngày in theo ngày gửi', group: GROUP_SLIP, sortOrder: 4, isItemVariable: false },
  { key: 'Thang', label: 'Tháng gửi', group: GROUP_SLIP, sortOrder: 5, isItemVariable: false },
  { key: 'Nam', label: 'Năm gửi', group: GROUP_SLIP, sortOrder: 6, isItemVariable: false },
  { key: 'Kho_Gui', label: 'Kho gửi', group: GROUP_SLIP, sortOrder: 7, isItemVariable: false },
  { key: 'Kho_Nhan', label: 'Kho nhận thành phẩm', group: GROUP_SLIP, sortOrder: 8, isItemVariable: false },
  { key: 'Nguoi_Lap', label: 'Người lập phiếu', group: GROUP_SLIP, sortOrder: 14, isItemVariable: false },
  { key: 'Ghi_Chu', label: 'Ghi chú', group: GROUP_SLIP, sortOrder: 15, isItemVariable: false },
  { key: 'Tong_So_Mat_Hang', label: 'Số dòng hàng mình gửi', group: GROUP_SLIP, sortOrder: 16, isItemVariable: false },
  {
    key: 'Nguyen_Lieu_NSX', label: 'Bảng nguyên liệu NSX bổ sung (không giá)', group: GROUP_SLIP, sortOrder: 17, isItemVariable: false,
    description: 'Bảng HTML dựng sẵn: mã, tên, lượng, đơn vị. Trống nếu không có.',
  },
  { key: 'Ma_Nha_San_Xuat', label: 'Mã nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 1, isItemVariable: false },
  { key: 'Nha_San_Xuat', label: 'Tên nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 2, isItemVariable: false },
  { key: 'Dien_Thoai_Nha_San_Xuat', label: 'SĐT nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 3, isItemVariable: false },
  { key: 'Dia_Chi_Nha_San_Xuat', label: 'Địa chỉ nhà sản xuất', group: GROUP_MANUFACTURER, sortOrder: 4, isItemVariable: false },
  { key: 'STT', label: 'STT', group: GROUP_ITEMS, sortOrder: 1, isItemVariable: true },
  { key: 'Ma_Hang', label: 'Mã hàng', group: GROUP_ITEMS, sortOrder: 2, isItemVariable: true },
  { key: 'Ten_Hang_Hoa', label: 'Tên hàng', group: GROUP_ITEMS, sortOrder: 3, isItemVariable: true },
  { key: 'Luong_Gui', label: 'Lượng gửi', group: GROUP_ITEMS, sortOrder: 4, isItemVariable: true },
  { key: 'Don_Vi_Gui', label: 'Đơn vị lượng gửi (g, kg, …)', group: GROUP_ITEMS, sortOrder: 5, isItemVariable: true },
  { key: 'So_Luong_Tru_Kho', label: 'Số lượng trừ kho', group: GROUP_ITEMS, sortOrder: 6, isItemVariable: true },
  { key: 'Don_Vi_Tinh', label: 'Đơn vị kho', group: GROUP_ITEMS, sortOrder: 7, isItemVariable: true },
];

export const PRODUCTION_EXTERNAL_ITEM_KEYS = PRODUCTION_EXTERNAL_VARIABLES
  .filter((item) => item.isItemVariable)
  .map((item) => item.key);

const cell = 'border: 1px solid #000; padding: 4px;';

export const PRODUCTION_EXTERNAL_DEFAULT_TEMPLATE = `<div style="font-family: Arial, sans-serif; font-size: 12px; padding: 8px;">
<div style="text-align: center;">
<div style="font-weight: bold;">{Ten_Cua_Hang}</div>
<div>{Dia_Chi_Cua_Hang}</div>
<h2 style="margin: 8px 0 2px;">PHIẾU GỬI SẢN XUẤT</h2>
<div>Mã phiếu: <strong>{Ma_Phieu_Gui}</strong> &middot; Ngày gửi: {Ngay_Gui}</div>
</div>
<hr>
<table style="width: 100%; border-collapse: collapse;" cellspacing="0" cellpadding="2">
<tbody>
<tr><td style="width: 32%;">Nhà sản xuất:</td><td><strong>{Nha_San_Xuat}</strong> ({Ma_Nha_San_Xuat})</td></tr>
<tr><td>Điện thoại / địa chỉ:</td><td>{Dien_Thoai_Nha_San_Xuat} &middot; {Dia_Chi_Nha_San_Xuat}</td></tr>
<tr><td>Kho gửi &rarr; kho nhận:</td><td>{Kho_Gui} &rarr; {Kho_Nhan}</td></tr>
</tbody>
</table>
<div style="margin-top: 8px; font-weight: bold;">Hàng gửi đi ({Tong_So_Mat_Hang} dòng)</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 4px;" cellspacing="0" cellpadding="4">
<thead>
<tr>
<th style="${cell} width: 6%;">STT</th>
<th style="${cell} width: 16%; text-align: left;">Mã hàng</th>
<th style="${cell} text-align: left;">Tên hàng</th>
<th style="${cell} width: 20%;">Lượng gửi</th>
<th style="${cell} width: 20%;">Trừ kho</th>
</tr>
</thead>
<tbody>
<tr>
<td style="${cell} text-align: center;">{STT}</td>
<td style="${cell}">{Ma_Hang}</td>
<td style="${cell}">{Ten_Hang_Hoa}</td>
<td style="${cell} text-align: center;">{Luong_Gui} {Don_Vi_Gui}</td>
<td style="${cell} text-align: center;">{So_Luong_Tru_Kho} {Don_Vi_Tinh}</td>
</tr>
</tbody>
</table>
{Nguyen_Lieu_NSX}
<div style="margin-top: 8px;">Ghi chú: {Ghi_Chu}</div>
<table style="width: 100%; border-collapse: collapse; margin-top: 20px; text-align: center;" cellspacing="0" cellpadding="4">
<tbody>
<tr>
<td style="width: 33%;"><strong>Người lập phiếu</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
<td style="width: 33%;"><strong>Người giao hàng</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
<td style="width: 34%;"><strong>Nhà sản xuất nhận</strong><br><em>(Ký, ghi rõ họ tên)</em></td>
</tr>
<tr>
<td style="padding-top: 48px;">{Nguoi_Lap}</td>
<td style="padding-top: 48px;"></td>
<td style="padding-top: 48px;"></td>
</tr>
</tbody>
</table>
</div>`;

const STATUS_LABEL: Record<number, string> = {
  1: 'Phiếu tạm',
  2: 'Hoàn thành',
  3: 'Đã hủy',
  4: 'Đã gửi',
  5: 'Nhận một phần',
};

const escapeHtml = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const qty = (value: unknown, digits = 4) =>
  value == null || value === ''
    ? ''
    : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });

const ddmmyyyy = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' });
};

/** Bảng nguyên liệu NSX bổ sung — chỉ mã, tên, lượng, đơn vị (không giá). */
function nsxMaterialsTable(lines: any[]): string {
  const rows = (lines ?? []).filter((line) => line && (line.productId || line.description));
  if (!rows.length) return '';
  const body = rows.map((line, index) => {
    const amount = line.pricingMode === 'TOTAL' || line.quantity == null ? '' : `${qty(line.quantity)} ${escapeHtml(line.unit)}`;
    return `<tr><td style="${cell} text-align: center;">${index + 1}</td><td style="${cell}">${escapeHtml(line.productCode)}</td><td style="${cell}">${escapeHtml(line.description)}</td><td style="${cell} text-align: center;">${amount}</td></tr>`;
  }).join('');
  return `<div style="margin-top: 8px; font-weight: bold;">Nguyên liệu nhà sản xuất bổ sung</div><table style="width: 100%; border-collapse: collapse; margin-top: 4px;" cellspacing="0" cellpadding="4"><thead><tr><th style="${cell} width: 6%;">STT</th><th style="${cell} width: 16%; text-align: left;">Mã hàng</th><th style="${cell} text-align: left;">Tên hàng</th><th style="${cell} width: 20%;">Lượng</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Dữ liệu in của phiếu gửi sản xuất. Cố ý không trả về trường tiền nào, cũng như
 * thành phẩm / sản lượng dự kiến / công thức — kể cả khi mẫu do người dùng tự
 * sửa có chèn các biến đó thì cũng không có dữ liệu để hiện.
 */
export function mapProductionExternal(p: any) {
  const sent = p.sentDate ?? p.createdAt;
  const date = sent ? new Date(sent) : null;
  const components = p.components ?? [];
  return {
    Ten_Cua_Hang: p.sourceBranch?.name || p.sourceBranchName || '',
    Dia_Chi_Cua_Hang: p.sourceBranch?.address || '',
    So_Dien_Thoai_Cua_Hang: p.sourceBranch?.contactNumber || '',
    Ma_Phieu_Gui: p.code || '',
    Trang_Thai: STATUS_LABEL[p.status] ?? '',
    Ngay_Gui: ddmmyyyy(sent),
    Ngay: date ? ddmmyyyy(date) : '',
    Thang: date ? String(date.getMonth() + 1) : '',
    Nam: date ? String(date.getFullYear()) : '',
    Kho_Gui: p.sourceBranchName || p.sourceBranch?.name || '',
    Kho_Nhan: p.destinationBranchName || p.destinationBranch?.name || '',
    Nguoi_Lap: escapeHtml(p.createdByName || p.creator?.name),
    Ghi_Chu: p.note || '',
    Tong_So_Mat_Hang: String(components.length),
    Nguyen_Lieu_NSX: nsxMaterialsTable(p.manufacturerMaterials),
    Ma_Nha_San_Xuat: escapeHtml(p.manufacturer?.code),
    Nha_San_Xuat: escapeHtml(p.manufacturer?.name),
    Dien_Thoai_Nha_San_Xuat: escapeHtml(p.manufacturer?.contactNumber),
    Dia_Chi_Nha_San_Xuat: escapeHtml(p.manufacturer?.address),
    items: components.map((line: any, index: number) => ({
      STT: String(index + 1),
      Ma_Hang: escapeHtml(line.componentCode),
      Ten_Hang_Hoa: escapeHtml(line.componentName),
      Luong_Gui: qty(line.actualGrams),
      Don_Vi_Gui: escapeHtml(line.unit === 'unit' ? line.componentProduct?.unit : line.unit),
      // Phiếu tạm chưa trừ kho: để trống thay vì 0.
      So_Luong_Tru_Kho: p.status === 1 ? '' : qty(line.unitsDeducted),
      Don_Vi_Tinh: p.status === 1 ? '' : escapeHtml(line.componentProduct?.unit),
    })),
  };
}
