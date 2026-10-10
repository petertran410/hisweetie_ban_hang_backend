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

export type VehiclePermissionAction = 'view' | 'create' | 'update' | 'manage';

export const VEHICLE_CHECK = {
  NORMAL: 'NORMAL',
  ABNORMAL: 'ABNORMAL',
} as const;

// Lark chỉ lấy các lần đổ từ 13/04/2026 làm mốc tính định mức tiêu hao.
export const FUEL_NORM_BASELINE_FROM = '2026-04-13';
