import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional,
  IsString, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { STOCK_SLIP_TYPES, StockSlipType } from './manufacturer-stock.util';

export class ManufacturerStockLineDto {
  @IsInt() @Min(1) productId: number;
  /** Gửi / Trả: lượng chuyển. Điều chỉnh: lượng thực tế còn tại NSX (được bằng 0). */
  @IsNumber() @Min(0) quantity: number;
  /** g | kg | đơn vị kho của sản phẩm. */
  @IsString() @MaxLength(40) unit: string;
}

export class ManufacturerStockSlipDto {
  /** Bắt buộc khi tạo; khi sửa phải trùng loại đang có. */
  @IsOptional() @IsIn(STOCK_SLIP_TYPES) type?: StockSlipType;
  /** Kho gửi (Gửi) / kho nhận (Trả); Điều chỉnh để trống. */
  @IsOptional() @IsInt() @Min(1) branchId?: number | null;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string | null;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200)
  @ValidateNested({ each: true }) @Type(() => ManufacturerStockLineDto)
  lines: ManufacturerStockLineDto[];
}
