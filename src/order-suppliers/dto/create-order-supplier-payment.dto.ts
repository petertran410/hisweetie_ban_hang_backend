import { ApiProperty } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  IsDateString,
  Min,
} from 'class-validator';

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

  @ApiProperty({
    description:
      'Tỉ giá quy đổi VND/CNY user nhập tại thời điểm thanh toán. ' +
      'Chỉ có khi NCC nước ngoài. Snapshot riêng ở OrderSupplierPayment — ' +
      'khác OrderSupplier.exchangeRate (tỉ giá đặt hàng, chỉ tham khảo).',
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  exchangeRate?: number;

  @ApiProperty({
    description:
      'Thành tiền quy đổi sang tiền tệ NCC (CNY) snapshot tại thời điểm ' +
      'thanh toán. = amount / exchangeRate. Chỉ có khi NCC nước ngoài.',
    required: false,
  })
  @IsNumber()
  @Min(0)
  @IsOptional()
  foreignAmount?: number;
}
