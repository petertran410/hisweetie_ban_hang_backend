import { IsArray, IsBoolean, IsInt, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class ManageCustomersDto {
  @IsArray()
  @IsInt({ each: true })
  @Type(() => Number)
  customerIds: number[];
}

export class CancelCustomerGroupDto {
  // true → gỡ hết khách khỏi nhóm rồi hủy (khách hàng vẫn giữ nguyên)
  @IsOptional()
  @IsBoolean()
  removeCustomers?: boolean;
}
