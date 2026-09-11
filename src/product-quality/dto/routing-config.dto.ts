import { IsNotEmpty, IsString, IsNumber, IsOptional, IsBoolean } from 'class-validator';

export class UpsertRoutingConfigDto {
  @IsNotEmpty()
  @IsString()
  initialClassification: string; // "Chất Lượng Sản Phẩm" | "Số lượng / Chủng loại" | "Vận chuyển / Đóng gói" | "DEFAULT"

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsNotEmpty()
  @IsNumber()
  decisionMakerId: number;

  @IsOptional()
  @IsBoolean()
  fallbackToCreator?: boolean;
}
