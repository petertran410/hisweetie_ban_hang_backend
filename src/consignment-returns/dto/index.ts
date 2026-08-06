import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Trạng thái phiếu hoàn hàng ký gửi.
 * Luồng 2 bước:
 *   REQUEST (1) -> STOCK_RECEIVED (2, hoàn kho). CANCELLED (5).
 * Không phát sinh công nợ/hoàn tiền (ký gửi B1/B2 chưa có nợ).
 */
export const CONSIGNMENT_RETURN_STATUS = {
  REQUEST: 1,
  STOCK_RECEIVED: 2,
  CANCELLED: 5,
} as const;

export const CONSIGNMENT_RETURN_STATUS_LABELS: Record<number, string> = {
  [CONSIGNMENT_RETURN_STATUS.REQUEST]: 'Chờ nhận hàng',
  [CONSIGNMENT_RETURN_STATUS.STOCK_RECEIVED]: 'Đã nhận hàng',
  [CONSIGNMENT_RETURN_STATUS.CANCELLED]: 'Đã hủy',
};

export function getReturnStatusLabel(status: number): string {
  return CONSIGNMENT_RETURN_STATUS_LABELS[status] || 'Không xác định';
}

export class ConsignmentReturnDetailDto {
  @IsInt()
  productId: number;

  @IsString()
  @IsOptional()
  productCode?: string;

  @IsString()
  @IsOptional()
  productName?: string;

  // Số lượng hoàn = tổng 3 bucket (server vẫn validate lại).
  @IsNumber()
  returnQuantity: number;

  @IsNumber()
  @IsOptional()
  goodQuantity?: number;

  @IsNumber()
  @IsOptional()
  damagedQuantity?: number;

  @IsNumber()
  @IsOptional()
  nearExpiryQuantity?: number;

  @IsString()
  @IsOptional()
  note?: string;
}

export class CreateConsignmentReturnDto {
  @IsInt()
  consignmentId: number;

  @IsString()
  @IsOptional()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsignmentReturnDetailDto)
  details: ConsignmentReturnDetailDto[];
}

export class ConsignmentReturnQueryDto {
  @IsInt()
  @IsOptional()
  @Type(() => Number)
  consignmentId?: number;

  @IsString()
  @IsOptional()
  search?: string;
}
