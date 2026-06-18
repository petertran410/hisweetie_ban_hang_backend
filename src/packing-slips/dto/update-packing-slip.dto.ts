import { PartialType } from '@nestjs/mapped-types';
import { CreatePackingSlipDto } from './create-packing-slip.dto';
import { Type } from 'class-transformer';

export class UpdatePackingSlipDto extends PartialType(CreatePackingSlipDto) {
  @Type(() => Number)
  cashAmount?: number;

  @Type(() => Number)
  feeGuiBen?: number;

  @Type(() => Number)
  feeGrab?: number;

  @Type(() => Number)
  cuocGuiHang?: number;

  @Type(() => Number)
  cuocNhanHang?: number;
}
