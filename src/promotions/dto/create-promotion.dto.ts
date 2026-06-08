import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PROMOTION_TYPES = [
  'INVOICE_DISCOUNT',
  'PRODUCT_DISCOUNT',
  'BUY_X_GET_Y',
  'BUY_N_GET_M_SAME',
  'BUY_X_BUY_Y_PRICE',
  'GIFT_BY_INVOICE',
  'CATEGORY_DISCOUNT',
] as const;

export const REWARD_TYPES = [
  'discount_percent',
  'discount_amount',
  'gift',
  'discounted_buy',
] as const;

export class PromotionProductRefDto {
  @IsOptional()
  @IsInt()
  productId?: number;

  @IsOptional()
  @IsString()
  categoryName?: string;
}

export class CreatePromotionRewardDto {
  @IsOptional()
  @IsInt()
  buyProductId?: number;

  @IsOptional()
  @IsString()
  buyCategoryName?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  buyQuantity?: number;

  @IsString()
  @IsIn(REWARD_TYPES as unknown as string[])
  rewardType: string;

  @IsOptional()
  @IsInt()
  rewardProductId?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rewardQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rewardValue?: number;

  // multi X/Y
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionProductRefDto)
  buyItems?: PromotionProductRefDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromotionProductRefDto)
  rewardItems?: PromotionProductRefDto[];
}

export class CreatePromotionDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsString()
  @IsIn(PROMOTION_TYPES as unknown as string[])
  type: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  priority?: number;

  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  applyTimeFrom?: string;

  @IsOptional()
  @IsString()
  applyTimeTo?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  applyWeekdays?: number[];

  @IsOptional()
  @IsBoolean()
  forAllBranch?: boolean;

  @IsOptional()
  @IsBoolean()
  forAllCustomer?: boolean;

  @IsOptional()
  @IsBoolean()
  forAllUser?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minOrderValue?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minQuantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxDiscountAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxRewardQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  usageLimit?: number;

  @IsOptional()
  @IsBoolean()
  autoApply?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  branchIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  customerIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  customerGroupIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePromotionRewardDto)
  rewards: CreatePromotionRewardDto[];
}
