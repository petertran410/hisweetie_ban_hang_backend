import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export const SUBCONTRACT_CURRENCIES = ['VND', 'CNY'] as const;

export const SUBCONTRACT_COST_TYPES = [
  'freight_out',
  'freight_in',
  'import_duty',
  'customs',
  'packaging',
  'compensation',
  'other',
] as const;

const toNumberArray = ({ value }: { value: any }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(Number);
  return String(value).split(',').map(Number);
};

export class SubcontractMaterialDto {
  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  plannedQuantity: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class SubcontractCostDto {
  @IsOptional()
  @IsIn(SUBCONTRACT_COST_TYPES)
  type?: string;

  @IsString()
  name: string;

  // VND, có dấu: bồi thường của nhà máy nhập số âm.
  @IsNumber()
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsBoolean()
  isFactoryPayable?: boolean;

  @IsOptional()
  @IsDateString()
  costDate?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateSubcontractOrderDto {
  @IsInt()
  @Type(() => Number)
  supplierId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number;

  @IsInt()
  @Type(() => Number)
  branchId: number;

  @IsInt()
  @Type(() => Number)
  receiveBranchId: number;

  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  formulaId?: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  plannedQuantity: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  processingUnitPrice: number;

  @IsOptional()
  @IsIn(SUBCONTRACT_CURRENCIES)
  currency?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  exchangeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  lossAllowancePercent?: number;

  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubcontractMaterialDto)
  materials?: SubcontractMaterialDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubcontractCostDto)
  costs?: SubcontractCostDto[];
}

// Không dùng PartialType: khi lệnh đã gửi nguyên liệu chỉ một số trường còn
// sửa được, service tự lọc theo trạng thái.
export class UpdateSubcontractOrderDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number | null;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  receiveBranchId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  formulaId?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  plannedQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  processingUnitPrice?: number;

  @IsOptional()
  @IsIn(SUBCONTRACT_CURRENCIES)
  currency?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  exchangeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  lossAllowancePercent?: number;

  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string | null;

  @IsOptional()
  @IsString()
  note?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubcontractMaterialDto)
  materials?: SubcontractMaterialDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubcontractCostDto)
  costs?: SubcontractCostDto[];
}

export class SubcontractOrderQueryDto {
  @IsOptional()
  @Transform(toNumberArray)
  status?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  branchIds?: number[];

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number = 15;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number = 0;
}

export class MaterialSuggestionQueryDto {
  @IsInt()
  @Type(() => Number)
  productId: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  formulaId?: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  quantity: number;

  @IsInt()
  @Type(() => Number)
  branchId: number;
}

export class AtFactoryQueryDto {
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  supplierId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  factoryId?: number;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;
}

export class SendMaterialLineDto {
  // id của SubcontractOrderMaterial
  @IsInt()
  @Type(() => Number)
  id: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  sentQuantity: number;
}

export class SendMaterialsDto {
  @IsOptional()
  @IsDateString()
  sentDate?: string;

  // Bỏ trống → gửi đúng số lượng kế hoạch của từng nguyên liệu.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SendMaterialLineDto)
  materials?: SendMaterialLineDto[];
}

export class CreateReceiptDto {
  @IsOptional()
  @IsDateString()
  receivedDate?: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  goodQuantity: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  defectQuantity?: number;

  @IsOptional()
  @IsString()
  note?: string;
}

export class ReturnMaterialLineDto {
  @IsInt()
  @Type(() => Number)
  id: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  returnedQuantity: number;
}

export class CompleteSubcontractOrderDto {
  @IsOptional()
  @IsDateString()
  completedDate?: string;

  // Nguyên liệu thừa nhà máy trả về; bỏ trống → không trả gì.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnMaterialLineDto)
  materials?: ReturnMaterialLineDto[];
}

export class CancelSubcontractOrderDto {
  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsBoolean()
  cancelPayments?: boolean;
}

export class ApplyCostDto {
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  newCost: number;

  @IsOptional()
  @IsIn(['receiveBranch', 'allBranches'])
  scope?: 'receiveBranch' | 'allBranches';

  // Giá vốn người dùng nhìn thấy lúc xem trước — lệch thì trả 409.
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  expectedOldCost?: number;
}

export class CreateSubcontractPaymentDto {
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  amount: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  accountId?: number;

  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  exchangeRate?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  foreignAmount?: number;

  // Trả vượt số còn nợ của lệnh (vd đặt cọc trước khi nhận hàng) cần xác nhận.
  @IsOptional()
  @IsBoolean()
  confirmExceed?: boolean;
}
