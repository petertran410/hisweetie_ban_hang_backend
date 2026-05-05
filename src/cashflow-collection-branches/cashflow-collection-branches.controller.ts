import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { CashFlowCollectionBranchesService } from './cashflow-collection-branches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Cash Flow Collection Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('cashflow-collection-branches')
export class CashFlowCollectionBranchesController {
  constructor(private service: CashFlowCollectionBranchesService) {}

  @Get()
  @RequirePermissions('cash_flows:view')
  @ApiOperation({ summary: 'Get all collection branches' })
  findAll() {
    return this.service.findAll();
  }

  @Post()
  @RequirePermissions('cash_flows:create')
  @ApiOperation({ summary: 'Create collection branch' })
  create(@Body() data: { name: string; description?: string }) {
    return this.service.create(data);
  }
}
