import { PartialType } from '@nestjs/mapped-types';
import { CreatePackingHangDto } from './create-packing-hang.dto';

export class UpdatePackingHangDto extends PartialType(CreatePackingHangDto) {}
