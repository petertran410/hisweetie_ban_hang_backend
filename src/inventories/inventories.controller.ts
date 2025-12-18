import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { InventoriesService } from './inventories.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Inventories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventories')
export class InventoriesController {
  constructor(private inventoriesService: InventoriesService) {}

  @Get('by-branch')
  @ApiOperation({ summary: 'Get inventory by branch' })
  getInventoryByBranch(
    @Query('branchId') branchId: string,
    @Query('productIds') productIds?: string,
  ) {
    const productIdArray = productIds
      ? productIds.split(',').map((id) => parseInt(id))
      : undefined;
    return this.inventoriesService.getInventoryByBranch(
      parseInt(branchId),
      productIdArray,
    );
  }

  @Get('product/:productId/branches')
  @ApiOperation({ summary: 'Get product inventory across all branches' })
  getProductInventoryAcrossBranches(@Query('productId') productId: string) {
    return this.inventoriesService.getProductInventoryAcrossBranches(
      parseInt(productId),
    );
  }
}
