import { IsInt, Min } from 'class-validator';

export class SaveTempQuantityDto {
  @IsInt()
  productId: number;

  @IsInt()
  @Min(0)
  quantity: number;
}
