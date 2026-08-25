import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Cấu hình leadtime logistics dùng chung toàn mạng lưới.
 * Mỗi chặng chỉ có khoảng nhanh nhất–chậm nhất, đơn vị ngày.
 */
export class UpdatePlanningNetworkConfigDto {
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) customsLeadtimeMin?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) customsLeadtimeMax?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) inboundLeadtimeMin?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) inboundLeadtimeMax?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) transferColdMin?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) transferColdMax?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) transferNormalMin?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) transferNormalMax?: number;
}
