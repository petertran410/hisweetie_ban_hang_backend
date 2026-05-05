import {
  Controller,
  Get,
  Put,
  Param,
  Body,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { InventoriesService } from './inventories.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { UpdateInventoryDto } from './dto';
import { RequirePermissions } from 'src/auth/decorators/permissions.decorator';

@ApiTags('Inventories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('inventories')
export class InventoriesController {
  constructor(private inventoriesService: InventoriesService) {}

  @Get('by-branch')
  @RequirePermissions('inventory:view')
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
  @RequirePermissions('inventory:view')
  @ApiOperation({ summary: 'Get product inventory across all branches' })
  getProductInventoryAcrossBranches(@Query('productId') productId: string) {
    return this.inventoriesService.getProductInventoryAcrossBranches(
      parseInt(productId),
    );
  }

  @Put(':productId/:branchId/condition')
  @RequirePermissions('inventory:update')
  @ApiOperation({
    summary: 'Update damaged/near-expiry quantity for a product at a branch',
  })
  async updateProductCondition(
    @Param('productId') productId: string,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateInventoryDto,
  ) {
    try {
      return await this.inventoriesService.updateProductCondition(
        parseInt(productId),
        parseInt(branchId),
        {
          damagedQuantity: dto.damagedQuantity,
          nearExpiryQuantity: dto.nearExpiryQuantity,
        },
      );
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }
}
