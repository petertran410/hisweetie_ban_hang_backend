import { PartialType } from '@nestjs/swagger';
import { CreateProductQualityTicketDto } from './create-product-quality-ticket.dto';
import { IsOptional, IsString } from 'class-validator';

export class UpdateProductQualityTicketDto extends PartialType(
  CreateProductQualityTicketDto,
) {
  @IsOptional()
  @IsString()
  status?: string;
}
