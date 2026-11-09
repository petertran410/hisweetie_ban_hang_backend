import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

// Query của báo cáo Phân tích › Kế Toán (accounting_dataset).

/** Nhận `?a=x&a=y` (mảng) hoặc `?a=x` (1 giá trị). KHÔNG tách theo dấu phẩy — tên hàng có thể chứa dấu phẩy. */
const toStrArray = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const arr: unknown[] = Array.isArray(value) ? value : [value];
  const out = arr
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .map((v) => String(v))
    .filter((v) => v.length > 0);
  return out.length ? out : undefined;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Giá trị đại diện cho "(Trống)" trong slicer (product_type = null). */
export const KE_TOAN_BLANK = '__blank__';

/** Trang Mapping Misa: slicer Loại Hàng (product_type) + Tên Hàng (product.name). */
export class KeToanMappingQueryDto {
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  productTypes?: string[];

  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  productNames?: string[];
}

/** Trang Tiền Mặt - Kho / Đối Soát: slicer Chi Nhánh (chọn 1) + Ngày (khoảng). */
export class KeToanCashQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  branch?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE)
  to?: string;
}

/** Trang Chuyển Hàng: slicer Tên Hàng. */
export class KeToanTransferQueryDto {
  @IsOptional()
  @Transform(toStrArray)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  productNames?: string[];
}
