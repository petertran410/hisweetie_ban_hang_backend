import {
  IsArray,
  IsInt,
  MaxLength,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ApprovalFormItemDto {
  @IsString()
  id: string;

  @IsString()
  type: string;

  @IsOptional()
  value?: unknown;
}

export class CreateApprovalRequestDto {
  @IsString()
  kind: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientUuid?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  branchId?: number;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  sourceId?: number;

  @IsOptional()
  metadata?: unknown;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApprovalFormItemDto)
  form: ApprovalFormItemDto[];
}

export class LinkApprovalCashFlowDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  cashFlowId: number;
}
