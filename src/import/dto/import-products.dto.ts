import { IsNotEmpty } from 'class-validator';

export class ImportProductsDto {
  @IsNotEmpty()
  file: Express.Multer.File;
}
