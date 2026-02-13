import { PartialType } from '@nestjs/mapped-types';
import { CreatePackingSlipDto } from './create-packing-slip.dto';

export class UpdatePackingSlipDto extends PartialType(CreatePackingSlipDto) {}
