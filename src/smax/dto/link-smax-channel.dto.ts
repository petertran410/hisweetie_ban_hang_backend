import { IsInt, IsNotEmpty } from 'class-validator';

export class LinkSmaxChannelDto {
  @IsInt()
  @IsNotEmpty()
  userId: number;
}
