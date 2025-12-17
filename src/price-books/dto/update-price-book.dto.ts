import { PartialType } from '@nestjs/mapped-types';
import { CreatePriceBookDto } from './create-price-book.dto';

export class UpdatePriceBookDto extends PartialType(CreatePriceBookDto) {}
