import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ConsignmentReturnsService } from './consignment-returns.service';
import { CreateConsignmentReturnDto, ConsignmentReturnQueryDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Consignment Returns')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consignment-returns')
export class ConsignmentReturnsController {
  constructor(private service: ConsignmentReturnsService) {}

  @Get()
  @RequirePermissions('consignment_returns:view')
  findAll(@Query() query: ConsignmentReturnQueryDto) {
    return this.service.findAll(query);
  }

  @Get('returnable/:consignmentId')
  @RequirePermissions('consignment_returns:view')
  getReturnable(@Param('consignmentId', ParseIntPipe) consignmentId: number) {
    return this.service.getReturnable(consignmentId);
  }

  @Get(':id')
  @RequirePermissions('consignment_returns:view')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions('consignment_returns:create')
  create(@Body() dto: CreateConsignmentReturnDto, @CurrentUser() user: any) {
    return this.service.create(dto, user.id);
  }

  @Put(':id/confirm-stock')
  @RequirePermissions('consignment_returns:update')
  confirmStockReceived(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: any,
  ) {
    return this.service.confirmStockReceived(id, user.id);
  }

  @Put(':id/cancel')
  @RequirePermissions('consignment_returns:cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: any) {
    return this.service.cancel(id, user.id);
  }
}
