import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class SmaxUserTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  token: string;
}
