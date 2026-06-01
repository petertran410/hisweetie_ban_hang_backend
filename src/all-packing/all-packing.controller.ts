import { Controller, Get, Query, UseGuards, Req } from '@nestjs/common';
import { AllPackingService } from './all-packing.service';
import { AllPackingQueryDto } from './dto/all-packing-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('All Packing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('all-packing')
export class AllPackingController {
  constructor(private allPackingService: AllPackingService) {}

  @Get()
  @RequirePermissions('packing_slips:view')
  @ApiOperation({ summary: 'Lấy danh sách tất cả loại báo đơn' })
  findAll(@Query() query: AllPackingQueryDto, @Req() req: any) {
    return this.allPackingService.findAll(query, req.user);
  }
}
