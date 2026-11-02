import { IsString, MaxLength } from 'class-validator';

/** Body của PATCH /customers/:id/comments — chỉ sửa ghi chú khách hàng. */
export class UpdateCustomerCommentsDto {
  @IsString()
  @MaxLength(1000)
  comments: string;
}
