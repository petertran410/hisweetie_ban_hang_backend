import { PartialType } from '@nestjs/mapped-types';
import { CreatePackingLoadingDto } from './create-packing-loading.dto';

export class UpdatePackingLoadingDto extends PartialType(
  CreatePackingLoadingDto,
) {}
