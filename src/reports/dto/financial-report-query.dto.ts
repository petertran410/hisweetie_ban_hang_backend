import { IsOptional, IsString, IsInt, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

// ViewType nhóm báo cáo Tài chính.
export const FINANCIAL_VIEW_TYPES = [
  'CashByGroup', // Thu chi theo nhóm
  'CashByTime', // Thu chi theo thời gian
  'CashFlowSummary', // Sổ quỹ (tồn đầu/thu/chi/tồn cuối)
  'SalePerformance', // Hiệu quả kinh doanh (doanh thu/giá vốn/lợi nhuận)
] as const;

export type FinancialViewType = (typeof FINANCIAL_VIEW_TYPES)[number];

export class FinancialReportQueryDto {
  @IsOptional()
  @IsString()
  @IsIn(FINANCIAL_VIEW_TYPES)
  viewType?: FinancialViewType;

  @IsOptional()
  @IsString()
  fromDate?: string;

  @IsOptional()
  @IsString()
  toDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  branchId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  cashFlowGroupId?: number;

  // 'receipt' | 'payment' | undefined (cả hai)
  @IsOptional()
  @IsString()
  @IsIn(['receipt', 'payment'])
  direction?: 'receipt' | 'payment';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
