import { IsNotEmpty, IsString, IsNumber, IsOptional, IsBoolean } from 'class-validator';

export class UpsertDepartmentMemberDto {
  @IsNotEmpty()
  @IsString()
  department: string; // Kinh Doanh | Kho + Logistics | Kế Toán Kho | Thu Mua

  @IsOptional()
  @IsNumber()
  branchId?: number;

  @IsNotEmpty()
  @IsNumber()
  userId: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
