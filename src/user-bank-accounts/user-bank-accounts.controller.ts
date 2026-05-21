import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserBankAccountsService } from './user-bank-accounts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CreateUserBankAccountDto } from './dto';

@ApiTags('User Bank Accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('user-bank-accounts')
export class UserBankAccountsController {
  constructor(private service: UserBankAccountsService) {}

  @Get()
  @RequirePermissions('bank_accounts:view')
  findAll() {
    return this.service.findAll();
  }

  @Get('by-user/:userId')
  @RequirePermissions('bank_accounts:view')
  findByUser(@Param('userId') userId: string) {
    return this.service.findByUser(+userId);
  }

  @Post()
  @RequirePermissions('bank_accounts:update')
  upsert(@Body() dto: CreateUserBankAccountDto) {
    return this.service.upsert(dto);
  }

  @Delete(':id')
  @RequirePermissions('bank_accounts:update')
  remove(@Param('id') id: string) {
    return this.service.remove(+id);
  }
}
