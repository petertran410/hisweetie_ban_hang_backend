import { PartialType } from '@nestjs/mapped-types';
import { CreateDestructionDto } from './create-destruction.dto';
import { IsInt, IsOptional } from 'class-validator';

export class UpdateDestructionDto extends PartialType(CreateDestructionDto) {
  @IsOptional()
  @IsInt()
  status?: number;
}
