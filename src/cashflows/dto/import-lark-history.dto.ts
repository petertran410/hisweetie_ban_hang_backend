import { IsArray, IsBoolean, IsString, ArrayMinSize } from 'class-validator';

export class ImportLarkHistoryDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  recordIds: string[];

  @IsBoolean()
  confirm: boolean;
}
