import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsNumber,
  MaxLength,
  ValidateNested,
  IsArray,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export const INTEL_ACTIONS = [
  'create_version_v1',
  'activate',
  'pause',
  'resume',
  'backfill',
  'cancel_backfill',
  'retry_failed',
  'set_budget',
  'set_alerts',
] as const;
export type IntelAction = (typeof INTEL_ACTIONS)[number];

/** Ngưỡng noul của phiên bản mới (0–1). */
export class IntelThresholdsDto {
  @IsNumber()
  @Min(0)
  @Max(1)
  yes!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  no!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  topic!: number;
}

export class IntelControlDto {
  @IsIn(INTEL_ACTIONS)
  action!: IntelAction;

  /** create_version_v1: tên + ngưỡng (mặc định theo taxonomy v1) */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => IntelThresholdsDto)
  thresholds?: IntelThresholdsDto;

  /** activate */
  @IsOptional()
  @IsInt()
  versionId?: number;

  /** backfill */
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  pagePids?: string[];

  /** set_alerts: bật / tắt gửi cảnh báo Lark */
  @IsOptional()
  @IsBoolean()
  alertsEnabled?: boolean;

  /** set_alerts: chat id nhóm Lark nhận (oc_…); chuỗi rỗng = nhóm mặc định */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  alertChatId?: string;

  /** set_budget: token / ngày */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  tokens?: number;
}
