import { IsOptional, IsNumberString } from 'class-validator';

/** Query phân trang cho danh sách thông báo (GET /notifications). */
export class NotificationQueryDto {
  /** id thông báo cuối của trang trước (cursor). */
  @IsOptional()
  @IsNumberString()
  cursor?: string;

  @IsOptional()
  @IsNumberString()
  limit?: string;
}
