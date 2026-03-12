import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { BankAccountsService } from './bank-accounts.service';
import { CreateBankAccountDto, UpdateBankAccountDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Bank Accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private bankAccountsService: BankAccountsService) {}

  @Get()
  @RequirePermissions('bank_accounts:view')
  findAll() {
    return this.bankAccountsService.findAll();
  }

  @Get(':id')
  @RequirePermissions('bank_accounts:view')
  findOne(@Param('id') id: string) {
    return this.bankAccountsService.findOne(+id);
  }

  @Get('for-payment')
  findAllForPayment() {
    return this.bankAccountsService.findAll();
  }

  @Post()
  @RequirePermissions('bank_accounts:create')
  create(@Body() dto: CreateBankAccountDto) {
    return this.bankAccountsService.create(dto);
  }

  @Put(':id')
  @RequirePermissions('bank_accounts:update')
  update(@Param('id') id: string, @Body() dto: UpdateBankAccountDto) {
    return this.bankAccountsService.update(+id, dto);
  }

  @Delete(':id')
  @RequirePermissions('bank_accounts:delete')
  remove(@Param('id') id: string) {
    return this.bankAccountsService.remove(+id);
  }
}
