import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { TransfersService } from './transfers.service';
import {
  CreateTransferDto,
  UpdateTransferDto,
  TransferQueryDto,
  CancelTransferDto,
} from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Transfers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transfers')
export class TransfersController {
  constructor(private transfersService: TransfersService) {}

  @Get()
  @RequirePermissions('transfers:view')
  findAll(@Query() query: TransferQueryDto) {
    return this.transfersService.findAll(query);
  }

  @Get(':id')
  @RequirePermissions('transfers:view')
  findOne(@Param('id') id: string) {
    return this.transfersService.findOne(+id);
  }

  @Post()
  @RequirePermissions('transfers:create')
  create(@Body() dto: CreateTransferDto, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.transfersService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('transfers:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTransferDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.transfersService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('transfers:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id || 1;
    return this.transfersService.remove(+id, userId);
  }

  @Put(':id/cancel')
  @RequirePermissions('transfers:update')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelTransferDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id || 1;
    return this.transfersService.cancelTransfer(+id, dto, userId);
  }
}
