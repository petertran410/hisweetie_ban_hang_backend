import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  IsDateString,
  IsIn,
  Min,
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

  @ApiProperty({
    required: false,
    description:
      'Đơn giá nhập. Có thể bỏ trống nếu user không có quyền xem giá vốn — ' +
      'backend sẽ tự lấy giá vốn hiện tại của sản phẩm theo chi nhánh.',
  })
  @IsOptional()
  @IsNumber()
  price?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  discount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  factoryPrice?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  factorySubTotal?: number;

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

export class UpdateOrderSupplierItemFactoryPriceDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  factoryPrice?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsNumber()
  factorySubTotal?: number | null;
}

export class UpdateOrderSupplierItemStageFactoryDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  productionStageId?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  factoryId?: number | null;
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

  @ApiProperty({
    required: false,
    description:
      'Id tài khoản ngân hàng công ty dùng để chuyển khoản cho NCC. ' +
      'Chỉ cần khi paymentMethod = "transfer". Map vào CashFlow.accountId và ' +
      'OrderSupplierPayment.accountId để đối chiếu sao kê ngân hàng.',
  })
  @IsOptional()
  @IsInt()
  paymentAccountId?: number;

  @ApiProperty({
    required: false,
    description:
      'Tỉ giá quy đổi VND/CNY user nhập tại thời điểm thanh toán (chỉ dùng cho ' +
      'NCC nước ngoài). Snapshot riêng ở OrderSupplierPayment.exchangeRate — ' +
      'khác OrderSupplier.exchangeRate (tỉ giá đặt hàng, chỉ tham khảo).',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  paymentExchangeRate?: number;

  @ApiProperty({
    required: false,
    description:
      'Thành tiền quy đổi sang tiền tệ NCC (CNY) snapshot tại thời điểm ' +
      'thanh toán. = paymentAmount / paymentExchangeRate. Snapshot riêng ở ' +
      'OrderSupplierPayment.foreignAmount — không quy đổi ngược từ VND.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  paymentForeignAmount?: number;

  @ApiProperty({ required: false, description: 'Dự kiến ngày nhập hàng' })
  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @ApiProperty({
    required: false,
    enum: ['VND', 'CNY'],
    default: 'VND',
    description:
      'Mã tiền tệ áp dụng cho phiếu (VND mặc định). Khi supplier thuộc nhóm ' +
      'nước ngoài (vd supplierGroupId = 1), FE sẽ gửi CNY kèm exchangeRate.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['VND', 'CNY'])
  currency?: string;

  @ApiProperty({
    required: false,
    default: 1,
    description:
      'Tỉ giá quy đổi (1 đơn vị currency = X VND). Ví dụ: 3500 = 1 CNY = 3500 VND. ' +
      'Mặc định 1. Bắt buộc > 0 khi currency = CNY.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  exchangeRate?: number;
}
