import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { VpsgCashService } from './vpsg-cash.service';

type Actor = { id: number; roles?: string[]; branchIds?: number[] };

class CancelVpsgCashRecordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

@ApiTags('VPSG Cash')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vpsg-cash')
export class VpsgCashController {
  constructor(private readonly service: VpsgCashService) {}

  @Get('accounts')
  accounts(@CurrentUser() user: Actor) {
    return this.service.accounts(user);
  }

  @Get('records')
  records(@Query('ids') ids: string | undefined, @CurrentUser() user: Actor) {
    const list = String(ids || '')
      .split(',')
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 200);
    return this.service.records(list, user);
  }

  @Post('transactions/:id/record')
  record(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: Actor) {
    return this.service.record(id, user);
  }

  @Post('transactions/:id/cancel')
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CancelVpsgCashRecordDto,
    @CurrentUser() user: Actor,
  ) {
    return this.service.cancel(id, dto.reason, user);
  }
}
