import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class IntelRangeQueryDto {
  @Type(() => Date)
  @IsDate()
  from!: Date;

  @Type(() => Date)
  @IsDate()
  to!: Date;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  pagePid?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  versionId?: number;
}

export class IntelMessagesQueryDto extends IntelRangeQueryDto {
  @IsOptional()
  @IsIn(['pending', 'processing', 'retry', 'completed', 'failed', 'skipped'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  intent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  topic?: string;

  @IsOptional()
  @IsIn(['positive', 'neutral', 'negative'])
  sentiment?: string;

  @IsOptional()
  @IsIn(['anomaly', 'escalation', 'reply'])
  flag?: 'anomaly' | 'escalation' | 'reply';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

export class ReviewLabelsDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  intent!: string | null;

  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  topics!: string[];

  @IsOptional()
  @IsIn(['positive', 'neutral', 'negative'])
  sentiment!: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  urgency!: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3)
  purchaseIntent!: number | null;

  @IsOptional()
  @IsBoolean()
  requiresReply!: boolean | null;

  @IsOptional()
  @IsBoolean()
  requiresEscalation!: boolean | null;

  @IsOptional()
  @IsBoolean()
  isAnomaly!: boolean | null;
}

export class SaveReviewDto {
  @IsString()
  @MaxLength(80)
  msgPid!: string;

  @ValidateNested()
  @Type(() => ReviewLabelsDto)
  labels!: ReviewLabelsDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class SandboxLineDto {
  @IsIn(['staff', 'customer'])
  role!: 'staff' | 'customer';

  @IsString()
  @MaxLength(500)
  text!: string;
}

export class SandboxDto {
  @IsString()
  @MaxLength(500)
  text!: string;

  @IsOptional()
  @IsBoolean()
  isGroup = false;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => SandboxLineDto)
  previous: SandboxLineDto[] = [];
}
