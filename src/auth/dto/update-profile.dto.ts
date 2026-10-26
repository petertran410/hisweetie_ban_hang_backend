import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Người dùng tự sửa hồ sơ: CHỈ 3 trường này. Trường lạ (vd `userRoles`,
 * `isActive`, `email`) bị ValidationPipe trả 400 — chặn tự nâng quyền.
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatar?: string;
}
