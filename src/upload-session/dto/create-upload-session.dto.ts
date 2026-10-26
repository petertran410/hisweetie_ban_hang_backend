import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

// Chỉ cho phép các subfolder dùng cho luồng bao-don (giống các form hiện có).
export const ALLOWED_SUBFOLDERS = [
  'bao-don',
  'dong-hang',
  'loading',
  'bao-don/chi-phi',
  'ky-gui',
] as const;
export type AllowedSubfolder = (typeof ALLOWED_SUBFOLDERS)[number];

export class CreateUploadSessionDto {
  @IsIn(ALLOWED_SUBFOLDERS as unknown as string[])
  subfolder: AllowedSubfolder;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  maxFiles?: number;
}
