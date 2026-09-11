import { IsOptional, IsString, IsNumber, IsArray } from 'class-validator';

export class AssignProductQualityTicketDto {
  @IsOptional()
  @IsNumber()
  decisionMakerId?: number;

  @IsOptional()
  @IsString()
  handlingDirection?: string;

  @IsOptional()
  @IsArray()
  assignedDepartments?: string[]; // Kinh Doanh, Kho + Logistics, Kế Toán Kho, Thu Mua

  @IsOptional()
  @IsString()
  severity?: string;

  @IsOptional()
  @IsArray()
  responsibilities?: string[];

  @IsOptional()
  @IsString()
  factoryName?: string;

  @IsOptional()
  @IsNumber()
  factoryId?: number;

  @IsOptional()
  @IsNumber()
  outboundInvoiceId?: number;

  @IsOptional()
  @IsString()
  outboundInvoiceCode?: string;
}
