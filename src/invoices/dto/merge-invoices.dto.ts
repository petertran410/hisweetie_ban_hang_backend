import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class MergeInvoicesDto {
  @IsArray()
  @ArrayMinSize(2)
  @IsInt({ each: true })
  @Min(1, { each: true })
  sourceInvoiceIds: number[];

  @IsInt()
  @Min(1)
  representativeInvoiceId: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
