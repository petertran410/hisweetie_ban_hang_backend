import { IsString, MinLength } from 'class-validator';

export class LarkSetupPasswordDto {
  @IsString()
  setupToken: string;

  @IsString()
  @MinLength(8, { message: 'Mật khẩu phải có ít nhất 8 ký tự' })
  password: string;

  @IsString()
  confirmPassword: string;
}
