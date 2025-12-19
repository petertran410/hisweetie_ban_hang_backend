import { IsOptional, IsArray, IsNumber, IsDateString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

export class TransferQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value ? value.split(',').map(Number) : undefined))
  @IsArray()
  @Type(() => Number)
  fromBranchIds?: number[];

  @IsOptional()
  @Transform(({ value }) => (value ? value.split(',').map(Number) : undefined))
  @IsArray()
  @Type(() => Number)
  toBranchIds?: number[];

  @IsOptional()
  @Transform(({ value }) => (value ? value.split(',').map(Number) : undefined))
  @IsArray()
  @Type(() => Number)
  status?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  pageSize?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  currentItem?: number = 0;

  @IsOptional()
  @IsDateString()
  fromReceivedDate?: string;

  @IsOptional()
  @IsDateString()
  toReceivedDate?: string;

  @IsOptional()
  @IsDateString()
  fromTransferDate?: string;

  @IsOptional()
  @IsDateString()
  toTransferDate?: string;
}
