import { IsString, IsInt, IsOptional } from 'class-validator';

export class CreatePostMetaDto {
  @IsInt()
  postId: number;

  @IsString()
  metaKey: string;

  @IsString()
  @IsOptional()
  metaValue?: string;
}

export class UpdatePostMetaDto {
  @IsString()
  @IsOptional()
  metaValue?: string;
}
