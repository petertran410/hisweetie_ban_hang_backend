import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsDateString } from 'class-validator';

export class CreateOrderSupplierPaymentDto {
  @ApiProperty({ description: 'ID đặt hàng nhập' })
  @IsNumber()
  orderSupplierId: number;

  @ApiProperty({ description: 'Số tiền thanh toán' })
  @IsNumber()
  amount: number;

  @ApiProperty({
    description: 'Phương thức thanh toán',
    enum: ['cash', 'transfer', 'card'],
    default: 'cash',
  })
  @IsString()
  @IsOptional()
  paymentMethod?: string;

  @ApiProperty({ description: 'ID tài khoản ngân hàng', required: false })
  @IsNumber()
  @IsOptional()
  accountId?: number;

  @ApiProperty({ description: 'Ngày thanh toán', required: false })
  @IsDateString()
  @IsOptional()
  paymentDate?: string;

  @ApiProperty({ description: 'Ghi chú', required: false })
  @IsString()
  @IsOptional()
  notes?: string;
}
