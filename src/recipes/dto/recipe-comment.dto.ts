import { IsString, MaxLength } from 'class-validator';

export class CreateRecipeCommentDto {
  @IsString()
  @MaxLength(2000)
  content: string;
}

export class UpdateRecipeCommentDto {
  @IsString()
  @MaxLength(2000)
  content: string;
}
