import { PartialType } from '@nestjs/mapped-types';
import { CreateOrderSupplierDto } from './create-order-supplier.dto';

export class UpdateOrderSupplierDto extends PartialType(
  CreateOrderSupplierDto,
) {}
