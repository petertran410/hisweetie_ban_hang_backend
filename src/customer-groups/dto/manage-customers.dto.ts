import { IsArray, IsInt } from 'class-validator';
import { Type } from 'class-transformer';

export class ManageCustomersDto {
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  customerIds: number[];
}
