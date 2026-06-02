import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

class OrderSupplierItemDto {
  @ApiProperty()
  @IsNumber()
  productId: number;

  @ApiProperty()
  @IsNumber()
  quantity: number;

  @ApiProperty()
  @IsNumber()
  price: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  discount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

class CreateOrderSupplierItemDto {
  @IsInt()
  productId: number;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsNumber()
  @IsOptional()
  discount?: number;

  @IsString()
  @IsOptional()
  description?: string;
}

export class CreateOrderSupplierDto {
  @ApiProperty({
    required: false,
    description:
      'Mã phiếu đặt hàng nhập do người dùng nhập. Để trống để hệ thống tự sinh mã PDN######.',
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty()
  @IsNumber()
  supplierId: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  branchId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  userId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  status?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  discount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  toComplete?: boolean;

  @ApiProperty({ type: [OrderSupplierItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderSupplierItemDto)
  items: OrderSupplierItemDto[];

  @ApiProperty({ required: false, description: 'Số tiền thanh toán trước' })
  @IsOptional()
  @IsNumber()
  paymentAmount?: number;

  @ApiProperty({
    required: false,
    enum: ['cash', 'transfer', 'card'],
    description: 'Phương thức thanh toán',
  })
  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @ApiProperty({ required: false, description: 'Dự kiến ngày nhập hàng' })
  @IsOptional()
  @IsDateString()
  orderDate?: string;
}
