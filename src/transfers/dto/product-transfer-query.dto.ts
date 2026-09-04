import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

export class ProductTransferQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId: number;
}