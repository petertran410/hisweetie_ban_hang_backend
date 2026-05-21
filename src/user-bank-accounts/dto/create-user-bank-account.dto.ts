import { IsInt, IsNotEmpty } from 'class-validator';

export class CreateUserBankAccountDto {
  @IsInt()
  @IsNotEmpty()
  userId!: number;

  @IsInt()
  @IsNotEmpty()
  bankAccountId!: number;
}
