import { PartialType } from '@nestjs/mapped-types';
import { CreateProductionDto } from './create-production.dto';

export class UpdateProductionDto extends PartialType(CreateProductionDto) {}
