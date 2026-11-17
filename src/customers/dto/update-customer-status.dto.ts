import { IsBoolean } from 'class-validator';

/** Body của PATCH /customers/:id/status — ngừng hoạt động / kích hoạt khách hàng. */
export class UpdateCustomerStatusDto {
  @IsBoolean()
  isActive: boolean;
}
