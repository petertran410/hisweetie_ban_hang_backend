import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ProductsService } from './products.service';
import { CreateProductDto, UpdateProductDto, ProductQueryDto } from './dto';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { AuthService } from '../auth/auth.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

const SUPER_ADMIN_ROLE = 'Super Admin';

@ApiTags('Products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    private productsService: ProductsService,
    private authService: AuthService,
    private permissionCache: PermissionCacheService,
  ) {}

  /**
   * Tính tập quyền hiệu lực của user theo chi nhánh đang chọn — mirror logic
   * của PermissionsGuard để strip field nhạy cảm khỏi response.
   */
  private async resolvePermissions(req: any): Promise<{
    isSuperAdmin: boolean;
    permissions: string[];
  }> {
    const user = req.user;
    if (!user || !user.id) return { isSuperAdmin: false, permissions: [] };
    if (user.roles?.includes(SUPER_ADMIN_ROLE)) {
      return { isSuperAdmin: true, permissions: [] };
    }

    const branchIdRaw =
      req.headers?.['x-branch-id'] || req.body?.branchId || req.query?.branchId;
    const branchId = branchIdRaw ? parseInt(String(branchIdRaw)) : undefined;

    if (branchId && !isNaN(branchId)) {
      const cached = this.permissionCache.getBranch(user.id, branchId);
      if (cached) return { isSuperAdmin: false, permissions: cached };
      const permissions = await this.authService.getPermissionsForBranch(
        user.id,
        branchId,
      );
      this.permissionCache.setBranch(user.id, branchId, permissions);
      return { isSuperAdmin: false, permissions };
    }

    return { isSuperAdmin: false, permissions: user.permissions || [] };
  }

  /**
   * Strip giá vốn (cost) + thông tin công bố khỏi 1 product nếu thiếu quyền.
   * Lưu ý: KHÔNG strip basePrice (giá bán) vì màn hình bán hàng cần — giá bán
   * chỉ ẩn ở UI.
   */
  private stripProduct(
    product: any,
    canViewCost: boolean,
    canViewPublication: boolean,
  ): any {
    if (!product || typeof product !== 'object') return product;

    if (!canViewCost && Array.isArray(product.inventories)) {
      product.inventories = product.inventories.map((inv: any) => ({
        ...inv,
        cost: undefined,
      }));
    }

    if (!canViewPublication) {
      product.publicationLocation = undefined;
      product.publicationDate = undefined;
      product.publicationLink = undefined;
      product.documents = undefined;
    }

    // Combo: strip giá vốn của component lồng bên trong
    if (!canViewCost && Array.isArray(product.comboComponents)) {
      product.comboComponents = product.comboComponents.map((c: any) => {
        if (c?.componentProduct?.inventories) {
          c.componentProduct.inventories = c.componentProduct.inventories.map(
            (inv: any) => ({
              ...inv,
              cost: undefined,
            }),
          );
        }
        return c;
      });
    }

    return product;
  }

  @Get()
  @RequirePermissions('products:view')
  async findAll(@Query() query: ProductQueryDto, @Req() req: any) {
    const result = await this.productsService.findAll(query);
    const { isSuperAdmin, permissions } = await this.resolvePermissions(req);
    const canViewCost =
      isSuperAdmin || permissions.includes('products:view_cost_price');
    const canViewPublication =
      isSuperAdmin || permissions.includes('products:view_publication');

    if (!canViewCost || !canViewPublication) {
      result.data = (result.data || []).map((p: any) =>
        this.stripProduct(p, canViewCost, canViewPublication),
      );
    }
    return result;
  }

  @Get('export')
  @RequirePermissions('products:export')
  async export(
    @Query() query: ProductQueryDto,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=DanhSachSanPham_${timestamp}.xlsx`,
    );

    await this.productsService.exportProducts(query, res);
  }

  @Get('reconcile-check')
  @RequirePermissions('products:view')
  reconcileCheck(@Query('productId') productId?: string) {
    return this.productsService.reconcileCheck(
      productId ? +productId : undefined,
    );
  }

  @Get('low-stock')
  @RequirePermissions('products:view')
  checkLowStock() {
    return this.productsService.checkLowStock();
  }

  @Get(':id/inventory-logs')
  @RequirePermissions('products:view')
  findInventoryLogs(
    @Param('id') id: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.findInventoryLogs(
      +id,
      branchId ? +branchId : undefined,
      page ? +page : 1,
      limit ? +limit : 5,
    );
  }

  @Get(':id')
  @RequirePermissions('products:view')
  async findOne(@Param('id') id: string, @Req() req: any) {
    const product = await this.productsService.findOne(+id);
    const { isSuperAdmin, permissions } = await this.resolvePermissions(req);
    const canViewCost =
      isSuperAdmin || permissions.includes('products:view_cost_price');
    const canViewPublication =
      isSuperAdmin || permissions.includes('products:view_publication');
    return this.stripProduct(product, canViewCost, canViewPublication);
  }

  @Post()
  @RequirePermissions('products:create')
  create(@Body() dto: CreateProductDto, @Req() req: any) {
    const userId = req.user?.id;
    return this.productsService.create(dto, userId);
  }

  @Put(':id')
  @RequirePermissions('products:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    return this.productsService.update(+id, dto, userId);
  }

  @Delete(':id')
  @RequirePermissions('products:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.productsService.remove(+id, userId);
  }
}
