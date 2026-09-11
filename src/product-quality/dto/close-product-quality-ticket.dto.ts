import { IsNotEmpty, IsString } from 'class-validator';

export class CloseProductQualityTicketDto {
  @IsNotEmpty({ message: 'Vui lòng nhập lý do kết thúc phiếu' })
  @IsString()
  reason: string;
}
