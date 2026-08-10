import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
  IsNumber,
  Min,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Sửa MỘT DÒNG của phiếu CLT (kể cả phiếu đã duyệt).
 *
 * Phạm vi cho sửa: NSX (expiryDate), số lượng (quantity), ghi chú (note).
 * KHÔNG cho đổi sản phẩm, loại tồn (toBucket) hay chiều (direction) — đổi những
 * thứ đó tương đương một phiếu khác, phải hủy rồi tạo lại để giữ vết rõ ràng.
 *
 * Không truyền field nào = giữ nguyên field đó.
 */
class UpdateStockConditionTransferItemDto {
  // Định danh dòng cần sửa (StockConditionTransferDetail.id).
  @IsInt()
  detailId: number;

  @IsOptional()
  @IsNumber()
  // Sửa phiếu cho phép về 0: giữ dòng để lưu lịch sử nhưng bỏ toàn bộ tác động
  // của dòng khỏi sổ cái. Create vẫn bắt buộc > 0 ở service create().
  @Min(0)
  quantity?: number;

  // NSX của lô (chỉ có nghĩa với toBucket = NEAR_EXPIRY).
  // Truyền null để xóa NSX (đưa về lô "chưa xác định NSX").
  @IsOptional()
  @IsDateString()
  expiryDate?: string | null;

  @IsOptional()
  @IsString()
  note?: string | null;
}

export class UpdateStockConditionTransferDto {
  // Ghi chú cấp phiếu.
  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateStockConditionTransferItemDto)
  items?: UpdateStockConditionTransferItemDto[];

  /**
   * Cho phép cập nhật LAN SANG hóa đơn: khi đổi NSX của một dòng cận date mà lô
   * cũ đã phát sinh bán, các dòng hóa đơn đã bán từ lô cũ sẽ được đổi
   * soldExpiryDate sang lô mới (kèm ghi lại log sổ cái tương ứng).
   *
   * Mặc định false → nếu việc đổi NSX làm lô âm thì CHẶN và báo lỗi kèm danh
   * sách hóa đơn ảnh hưởng, để người dùng xem trước rồi mới quyết.
   */
  @IsOptional()
  @IsBoolean()
  cascadeInvoices?: boolean;
}
