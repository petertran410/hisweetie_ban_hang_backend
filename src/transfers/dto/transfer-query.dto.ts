import { Type } from 'class-transformer';
import { IsOptional, IsArray } from 'class-validator';

export class TransferQueryDto {
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  fromBranchIds?: number[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  toBranchIds?: number[];

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  status?: number[];

  @IsOptional()
  @Type(() => Number)
  pageSize?: number = 20;

  @IsOptional()
  @Type(() => Number)
  currentItem?: number = 0;

  @IsOptional()
  @Type(() => Date)
  fromReceivedDate?: Date;

  @IsOptional()
  @Type(() => Date)
  toReceivedDate?: Date;

  @IsOptional()
  @Type(() => Date)
  fromTransferDate?: Date;

  @IsOptional()
  @Type(() => Date)
  toTransferDate?: Date;
}
