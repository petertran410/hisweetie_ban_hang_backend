import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MinLength,
} from 'class-validator';

const WEBHOOK_RESOURCES = [
  'branches',
  'customer-types',
  'customer-groups',
  'customers',
  'products',
  'inventories',
  'orders',
  'invoices',
  'return-orders',
  'categories',
  'trademarks',
  'sale-channels',
  'bank-accounts',
  'users',
  'suppliers',
  'supplier-groups',
  'price-books',
  'purchase-orders',
  'transfers',
  'cashflows',
  'surchages',
  'locations',
  'settings',
  'order-suppliers',
  'consignments',
  'supplier-returns',
];

export class RegisterWebhookDto {
  @IsIn(WEBHOOK_RESOURCES)
  resource!: string;

  // Bắt buộc HTTPS: payload chứa dữ liệu khách hàng và đơn hàng, gửi qua HTTP
  // trần là để lộ trên đường truyền.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  url!: string;

  @IsOptional()
  @IsString()
  @Length(16, 255)
  secret?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  description?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isActive?: boolean;
}
