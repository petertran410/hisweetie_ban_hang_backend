import { IsIn, IsString, Length } from 'class-validator';

export class ResolveScanDto {
  @IsString()
  @Length(1, 500)
  payload: string;

  @IsIn(['packing-slip', 'packing-hang', 'packing-loading'])
  packingType: 'packing-slip' | 'packing-hang' | 'packing-loading';
}
