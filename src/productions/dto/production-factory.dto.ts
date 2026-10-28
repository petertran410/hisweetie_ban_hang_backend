import {
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductionComponentDto } from './create-production.dto';

/** Phiếu tạm → Đã gửi: xuất nguyên liệu khỏi kho, gửi sang nhà máy. */
export class SendProductionDto {
  @IsOptional()
  @IsDateString()
  sentDate?: string;

  // Bỏ trống → dùng nguyên liệu đã lưu ở phiếu tạm (hoặc định mức công thức).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductionComponentDto)
  components?: ProductionComponentDto[];
}

/** Đã gửi → Hoàn thành: nhà máy giao thành phẩm. */
export class ReceiveProductionDto {
  @IsOptional()
  @IsDateString()
  completedDate?: string;

  // Bỏ trống → nhận đúng số lượng của phiếu.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  receivedQuantity?: number;

  // Có giá trị → ghi luôn giá vốn thành phẩm (người dùng đã xác nhận).
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  newCost?: number;

  @IsOptional()
  @IsIn(['receiveBranch', 'allBranches'])
  costScope?: 'receiveBranch' | 'allBranches';
}

export class ApplyProductionCostDto {
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  newCost: number;

  @IsOptional()
  @IsIn(['receiveBranch', 'allBranches'])
  scope?: 'receiveBranch' | 'allBranches';

  // Giá vốn người dùng thấy lúc xem trước — lệch thì trả 409.
  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  expectedOldCost?: number;
}

export class CostPreviewQueryDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  receivedQuantity?: number;
}

export class CancelSentProductionDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
