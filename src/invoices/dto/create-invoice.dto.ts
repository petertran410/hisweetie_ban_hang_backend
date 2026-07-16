import {
  IsInt,
  IsOptional,
  IsString,
  IsBoolean,
  IsDateString,
  IsArray,
  ValidateNested,
  IsNumber,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

class CreateInvoiceDetailDto {
  @IsInt()
  productId: number;

  @IsString()
  productCode: string;

  @IsString()
  productName: string;

  @IsNumber()
  quantity: number;

  @IsNumber()
  price: number;

  @IsOptional()
  @IsNumber()
  discount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsNumber()
  totalPrice: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  @IsIn(['normal', 'damaged', 'near_expiry'])
  conditionType?: string; // "normal" | "damaged" | "near_expiry"

  @IsOptional()
  @IsString()
  @IsIn(['normal', 'gift', 'promo_discount', 'discounted_buy'])
  lineType?: string;

  @IsOptional()
  @IsBoolean()
  isGift?: boolean;

  @IsOptional()
  @IsInt()
  promotionId?: number;

  @IsOptional()
  @IsInt()
  triggerProductId?: number;

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  enabledPromotionIds?: number[];
}

class CreateInvoiceDeliveryDto {
  @IsString()
  receiver: string;

  @IsString()
  contactNumber: string;

  @IsString()
  address: string;

  @IsOptional()
  @IsString()
  locationName?: string;

  @IsOptional()
  @IsString()
  wardName?: string;

  @IsOptional()
  @IsNumber()
  weight?: number;

  @IsOptional()
  @IsString()
  weightUnit?: string;

  @IsOptional()
  @IsNumber()
  length?: number;

  @IsOptional()
  @IsNumber()
  width?: number;

  @IsOptional()
  @IsNumber()
  height?: number;

  @IsString()
  @IsOptional()
  noteForDriver?: string;
}

class CreateInvoicePaymentItemDto {
  @IsString()
  method: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsInt()
  accountId?: number;
}

class RewardSelectionDto {
  @IsInt()
  productId: number;

  // Số suất phân bổ cho SP quà này (mỗi suất = rewardQuantity của CT).
  @IsInt()
  rewardTimes: number;
}

class AppliedPromotionDto {
  @IsInt()
  promotionId: number;

  // Mã SP điều kiện mua X đã kích hoạt lần áp dụng này.
  @IsOptional()
  @IsInt()
  triggerProductId?: number;

  // Lựa chọn quà (khi nhóm Y có nhiều SP, thu ngân chọn 1)
  @IsOptional()
  @IsInt()
  giftProductId?: number;

  @IsOptional()
  @IsNumber()
  giftQuantity?: number;

  // Lựa chọn mua kèm giá KM
  @IsOptional()
  @IsInt()
  discountedBuyProductId?: number;

  @IsOptional()
  @IsNumber()
  discountedBuyQuantity?: number;

  // KM cộng dồn: phân bổ quà theo nhiều SP (mỗi SP nhận n suất × rewardQuantity).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RewardSelectionDto)
  rewardSelections?: RewardSelectionDto[];
}

export class CreateInvoiceDto {
  @IsOptional()
  @IsInt()
  customerId?: number;

  @IsOptional()
  @IsInt()
  branchId?: number;

  @IsOptional()
  @IsInt()
  soldById?: number;

  @IsOptional()
  @IsInt()
  saleChannelId?: number;

  @IsOptional()
  @IsNumber()
  priceBookId?: number;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsBoolean()
  usingCod?: boolean;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  discountRatio?: number;

  @IsOptional()
  @IsNumber()
  paidAmount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoicePaymentItemDto)
  payments?: CreateInvoicePaymentItemDto[];

  @IsOptional()
  @IsInt()
  status?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceDetailDto)
  items: CreateInvoiceDetailDto[];

  @IsOptional()
  @IsBoolean()
  skipPromotions?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  appliedPromotionIds?: number[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AppliedPromotionDto)
  appliedPromotions?: AppliedPromotionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateInvoiceDeliveryDto)
  delivery?: CreateInvoiceDeliveryDto;
}

export class CreateInvoiceFromOrderDto {
  @IsNumber()
  @IsOptional()
  additionalPayment?: number;

  @IsOptional()
  @IsArray()
  payments?: Array<{ method: string; amount: number }>;

  @IsOptional()
  @IsNumber()
  soldById?: number;

  // Khi đơn hàng có ít nhất 1 mã xuất thiếu so với số lượng đặt, FE hỏi người dùng
  // có muốn kết thúc đơn hàng không. true => ép hoàn thành (status 3) thay vì Ra 1 phần HĐ (status 6).
  @IsOptional()
  @IsBoolean()
  forceComplete?: boolean;

  @IsArray()
  @IsOptional()
  items?: {
    productId: number;
    productCode: string;
    productName: string;
    quantity: number;
    price: number;
    discount: number;
    discountRatio: number;
    totalPrice: number;
    note?: string;
    conditionType?: string; // "normal" | "damaged" | "near_expiry"
    lineType?: string; // normal | gift | discounted_buy
    isGift?: boolean;
    promotionId?: number;
    triggerProductId?: number;
    enabledPromotionIds?: number[];
  }[];
}
