import { IsOptional, IsInt, IsString } from 'class-validator';
import { Type, Transform } from 'class-transformer';

const toNumberArray = ({ value }: { value: any }) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(Number);
  return String(value).split(',').map(Number);
};

export class ProductionQueryDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  branchIds?: number[];

  @IsOptional()
  @Transform(({ value }) => {
    if (!value) return undefined;
    if (Array.isArray(value)) return value.map(Number);
    return value.split(',').map(Number);
  })
  status?: number[];

  @IsOptional()
  @IsString()
  fromManufacturedDate?: string;

  @IsOptional()
  @IsString()
  toManufacturedDate?: string;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  pageSize?: number = 15;

  @IsOptional()
  @IsInt()
  @Type(() => Number)
  currentItem?: number = 0;

  @IsOptional()
  @IsString()
  search?: string;

  // true = chỉ phiếu Gửi sản xuất, false = chỉ sản xuất nội bộ.
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === ''
      ? undefined
      : value === true || value === 'true',
  )
  isExternal?: boolean;

  @IsOptional()
  @IsString()
  fromCreatedDate?: string;

  @IsOptional()
  @IsString()
  toCreatedDate?: string;

  // Phiếu gửi sản xuất: lọc theo nhà máy / NCC.
  @IsOptional()
  @Transform(toNumberArray)
  factoryIds?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  supplierIds?: number[];

  @IsOptional()
  @Transform(toNumberArray)
  createdByIds?: number[];

  // Thành phẩm của phiếu.
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  productId?: number;

  // Phiếu có dùng nguyên liệu này.
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  componentProductId?: number;
}
