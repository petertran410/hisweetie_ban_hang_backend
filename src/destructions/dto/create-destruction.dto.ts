import {
  IsInt,
  IsOptional,
  IsString,
  IsArray,
  ValidateNested,
  IsNumber,
  Min,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

class DestructionDetailDto {
  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  @Min(0)
  quantity: number;

  // Bỏ trống khi user thiếu quyền products:view_cost_price (API products đã
  // bỏ cost) → service tự lấy giá vốn hiện tại theo chi nhánh phiếu hủy.
  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;
}

export class CreateDestructionDto {
  @IsInt()
  branchId: number;

  @IsOptional()
  @IsBoolean()
  isDraft?: boolean;

  @IsOptional()
  @IsString()
  note?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DestructionDetailDto)
  destructionDetails: DestructionDetailDto[];
}
