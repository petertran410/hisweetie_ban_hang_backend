export const VEHICLE_SERVICE = {
  REGISTRATION: 'Đăng kiểm xe',
  INSURANCE: 'Mua bảo hiểm bắt buộc',
  OIL_CHANGE: 'Thay nhớt',
} as const;

export const VEHICLE_SERVICE_TYPES = [
  'Rửa xe',
  'Bảo dưỡng',
  VEHICLE_SERVICE.OIL_CHANGE,
  'Sửa chữa',
  'Chăm sóc xe',
  VEHICLE_SERVICE.REGISTRATION,
  VEHICLE_SERVICE.INSURANCE,
  'Phạt nguội',
  'Phạt nóng',
  'Mua đường',
] as const;

export const VEHICLE_ATTACHMENT_KIND = {
  PUMP_METER: 'PUMP_METER',
  INVOICE: 'INVOICE',
  PHOTO: 'PHOTO',
  EVIDENCE: 'EVIDENCE',
} as const;

export const VEHICLE_ATTACHMENT_KINDS = Object.values(VEHICLE_ATTACHMENT_KIND);

export const VEHICLE_TYPES = ['CAR', 'MOTORBIKE'] as const;
export const VEHICLE_FUEL_TYPES = ['GASOLINE', 'DIESEL'] as const;

export const VEHICLE_SCOPES = [
  { key: 'hn', branchIds: [6] },
  { key: 'sg', branchIds: [1] },
] as const;

export type VehiclePermissionAction =
  | 'view'
  | 'create'
  | 'update'
  | 'manage'
  | 'export';

export const VEHICLE_CHECK = {
  NORMAL: 'NORMAL',
  ABNORMAL: 'ABNORMAL',
} as const;

/** Cờ ODO của phiếu xăng (xét theo thứ tự ngày đổ). */
export const VEHICLE_ODO_CHECK = {
  /** ODO lệch thứ tự: cao hơn các lần đổ sau hoặc thấp hơn các lần đổ trước. */
  BACKWARD: 'BACKWARD',
  /** Km tới lần đổ kế tiếp vượt FUEL_MAX_KM_BETWEEN_FILLS (ODO sai hoặc thiếu phiếu). */
  JUMP: 'JUMP',
} as const;

/** Km giữa hai lần đổ vượt mức này thì không tính tiêu hao cho cặp đó. */
export const FUEL_MAX_KM_BETWEEN_FILLS = 2000;

/** Chênh lệch cho phép (L/100km) quanh định mức của xe, cả hai chiều. */
export const FUEL_NORM_TOLERANCE = 1;

/** Số tháng gần nhất dùng để tính "L/100km thực tế" trong Danh sách xe. */
export const FUEL_RECENT_MONTHS = 2;
