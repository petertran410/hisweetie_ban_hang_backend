import { IsOptional, IsBoolean } from 'class-validator';

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  managerCustomerByBranch?: boolean;

  @IsOptional()
  @IsBoolean()
  allowOrderWhenOutStock?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSellWhenOrderOutStock?: boolean;

  @IsOptional()
  @IsBoolean()
  allowSellWhenOutStock?: boolean;

  @IsOptional()
  @IsBoolean()
  syncKiotEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  sepayFilterByAccount?: boolean;

  @IsOptional()
  @IsBoolean()
  larkProductRetryCronEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  misaDictionaryCronEnabled?: boolean;
}
