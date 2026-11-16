import {
  IsOptional,
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  IsInt,
  Min,
  Max,
} from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  contractDocumensoSyncCronEnabled?: boolean;

  /** User nhận tin Lark khi KH đổi mã số thuế (rỗng = tắt). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  larkTaxCodeNotifyUserIds?: number[];

  /** User được giao task Lark khi có KH mới (rỗng = tắt). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsInt({ each: true })
  @Min(1, { each: true })
  larkNewCustomerTaskUserIds?: number[];

  /** Hạn task KH mới = lúc tạo + N ngày. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  larkNewCustomerTaskDueDays?: number;
}
