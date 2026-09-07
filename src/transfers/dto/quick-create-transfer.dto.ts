import { ArrayMinSize, IsArray, IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class QuickCreateTransferDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  transferId?: number;

  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsInt({ each: true })
  productIds: number[];
}
