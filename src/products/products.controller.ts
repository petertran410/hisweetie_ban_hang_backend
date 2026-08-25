import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { ProductsService } from './products.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ProductQueryDto,
  BulkUpdateCargoTypeDto,
} from './dto';
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
   * Nếu user KHÔNG có quyền `products:assign_factory` mà body có gửi kèm
   * `factoryMappings` → âm thầm loại bỏ (không ghi đè dữ liệu nhà máy thật,
   * không ném lỗi). Super Admin luôn được phép. Đây là lớp chặn backend bổ
   * trợ cho việc ẩn/disable ở frontend.
   */
  private async stripFactoryFieldsIfNoPermission<
    T extends { factoryMappings?: unknown },
  >(dto: T, req: any): Promise<T> {
    if (dto?.factoryMappings === undefined) return dto;

    const { isSuperAdmin, permissions } = await this.resolvePermissions(req);
    const canAssignFactory =
      isSuperAdmin || permissions.includes('products:assign_factory');
    if (canAssignFactory) return dto;

    const sanitized = { ...dto };
    delete sanitized.factoryMappings;
    return sanitized;
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

  @Get(':id/condition-logs')
  @RequirePermissions('products:view')
  findConditionLogs(
    @Param('id') id: string,
    @Query('bucket') bucket: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.findConditionLogs(
      +id,
      bucket,
      branchId ? +branchId : undefined,
      page ? +page : 1,
      limit ? +limit : 15,
    );
  }

  @Get('pos-near-expiry-lots/:id')
  findPosNearExpiryLots(
    @Param('id') id: string,
    @Query('branchId') branchId: string,
  ) {
    return this.productsService.findNearExpiryLots(+id, +branchId);
  }

  @Get(':id/near-expiry-lots')
  @RequirePermissions('products:view')
  findNearExpiryLots(
    @Param('id') id: string,
    @Query('branchId') branchId: string,
  ) {
    return this.productsService.findNearExpiryLots(+id, +branchId);
  }

  @Get(':id/condition-summary')
  @RequirePermissions('products:view')
  getConditionSummary(
    @Param('id') id: string,
    @Query('branchId') branchId: string,
  ) {
    return this.productsService.getConditionSummary(+id, +branchId);
  }

  /**
   * Tồn 3 bucket của NHIỀU sản phẩm trong 1 chi nhánh, đọc TỪ SỔ CÁI.
   * Dùng cho dropdown bán hàng: trước đây FE đọc cache Inventory
   * (damagedQuantity/nearExpiryQuantity/promoQuantity) nên bị lệch khi cache
   * trôi khỏi sổ cái. Endpoint này trả về đúng nguồn chân lý.
   *
   * LƯU Ý: route tĩnh này PHẢI khai báo trước @Get(':id') để không bị Nest
   * match thành param id.
   */
  @Get('condition-summary-batch')
  @RequirePermissions('products:view')
  getConditionSummaryBatch(
    @Query('productIds') productIds: string,
    @Query('branchId') branchId: string,
  ) {
    const ids = (productIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
    return this.productsService.getConditionSummaryBatch(ids, +branchId);
  }

  /**
   * POS-only condition stock lookup. The POS cart needs these quantities to
   * decide whether to show the Damaged/Near-expiry actions; it must not require
   * the general product-view permission. Authentication still applies globally.
   */
  @Get('pos-condition-summary-batch')
  getPosConditionSummaryBatch(
    @Query('productIds') productIds: string,
    @Query('branchId') branchId: string,
  ) {
    const ids = (productIds || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 0);
    return this.productsService.getConditionSummaryBatch(ids, +branchId);
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
  async create(@Body() dto: CreateProductDto, @Req() req: any) {
    const userId = req.user?.id;
    const sanitized = await this.stripFactoryFieldsIfNoPermission(dto, req);
    return this.productsService.create(sanitized, userId);
  }

  /**
   * Gán loại hàng (COLD/NORMAL) hàng loạt. Đặt TRƯỚC `@Put(':id')` để tránh
   * route param nuốt path tĩnh.
   */
  @Patch('bulk-cargo-type')
  @RequirePermissions('products:update')
  async bulkUpdateCargoType(
    @Body() dto: BulkUpdateCargoTypeDto,
    @Req() req: any,
  ) {
    return this.productsService.bulkUpdateCargoType(dto, req.user?.id);
  }

  @Put(':id')
  @RequirePermissions('products:update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Req() req: any,
  ) {
    const userId = req.user?.id;
    const sanitized = await this.stripFactoryFieldsIfNoPermission(dto, req);
    return this.productsService.update(+id, sanitized, userId);
  }

  @Delete(':id')
  @RequirePermissions('products:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.productsService.remove(+id, userId);
  }
}
