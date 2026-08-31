import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import {
  CalculateCostDto,
  CloneRecipeDto,
  CreateRecipeCommentDto,
  CreateRecipeCategoryDto,
  CreateRecipeDto,
  PublishRecipeDto,
  RecipeQueryDto,
  UpdateRecipeDto,
  UpdateRecipeCommentDto,
} from './dto';
import { RecipesService } from './recipes.service';
import { AuthService } from '../auth/auth.service';
import { PermissionCacheService } from '../permission-cache/permission-cache.service';

@ApiTags('Recipes')
@ApiBearerAuth()
@Controller()
export class RecipesController {
  constructor(
    private readonly recipes: RecipesService,
    private readonly authService: AuthService,
    private readonly permissionCache: PermissionCacheService,
  ) {}

  @Get('recipes')
  @RequirePermissions('recipes:view')
  findAll(@Query() query: RecipeQueryDto, @Req() req: any) {
    return this.withCostPermission(req, (includeCost) =>
      this.recipes.findAll(query, includeCost),
    );
  }

  @Get('recipe-categories')
  @RequirePermissions('recipes:view')
  categories() {
    return this.recipes.getCategories();
  }

  @Get('recipes/ingredient-options')
  @RequirePermissions('recipes:view')
  ingredientOptions() {
    return this.recipes.getIngredientOptions();
  }

  @Get('recipes/ingredient-products')
  @RequirePermissions('recipes:view')
  ingredientProducts(
    @Query('search') search: string | undefined,
    @Req() req: any,
  ) {
    return this.getIngredientProducts(search, req);
  }

  @Get('recipes/semi-finished-options')
  @RequirePermissions('recipes:view')
  semiFinishedOptions(
    @Query('search') search: string | undefined,
    @Query('excludeId') excludeId: string | undefined,
    @Req() req: any,
  ) {
    const excluded = excludeId ? Number(excludeId) : undefined;
    return this.withCostPermission(req, (includeCost) => this.recipes.getSemiFinishedOptions(
      search,
      excluded && Number.isInteger(excluded) ? excluded : undefined,
      includeCost,
    ));
  }

  private async getIngredientProducts(search: string | undefined, req: any) {
    const user = req.user;
    if (!user?.id) return this.recipes.getIngredientProducts(search, false);
    if (user.roles?.includes('Super Admin')) {
      return this.recipes.getIngredientProducts(search, true);
    }
    const branchIdRaw = req.headers?.['x-branch-id'];
    const branchId = branchIdRaw ? Number(branchIdRaw) : undefined;
    let permissions = user.permissions || [];
    if (branchId && Number.isInteger(branchId)) {
      permissions =
        this.permissionCache.getBranch(user.id, branchId) ||
        (await this.authService.getPermissionsForBranch(user.id, branchId));
      this.permissionCache.setBranch(user.id, branchId, permissions);
    }
    return this.recipes.getIngredientProducts(
      search,
      permissions.includes('recipes:view_cost'),
    );
  }

  @Post('recipe-categories')
  @RequirePermissions('recipes:create')
  createCategory(@Body() dto: CreateRecipeCategoryDto) {
    return this.recipes.createCategory(dto);
  }

  @Post('recipes')
  @RequirePermissions('recipes:create')
  create(@Body() dto: CreateRecipeDto, @Req() req: any) {
    return this.recipes.create(dto, req.user?.id || 1);
  }

  @Get('recipes/:id')
  @RequirePermissions('recipes:view')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.withCostPermission(req, (includeCost) =>
      this.recipes.findOne(+id, includeCost),
    );
  }

  @Patch('recipes/:id')
  @RequirePermissions('recipes:update')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRecipeDto,
    @Req() req: any,
  ) {
    return this.recipes.update(+id, dto, req.user?.id || 1);
  }

  @Delete('recipes/:id')
  @RequirePermissions('recipes:delete')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.recipes.remove(+id, req.user?.id || 1);
  }

  @Post('recipes/:id/publish')
  @RequirePermissions('recipes:publish')
  publish(
    @Param('id') id: string,
    @Body() dto: PublishRecipeDto,
    @Req() req: any,
  ) {
    return this.recipes.publish(+id, dto, req.user?.id || 1);
  }

  @Post('recipes/:id/unpublish')
  @RequirePermissions('recipes:publish')
  unpublish(@Param('id') id: string, @Req() req: any) {
    return this.recipes.unpublish(+id, req.user?.id || 1);
  }

  @Post('recipes/:id/archive')
  @RequirePermissions('recipes:archive')
  archive(@Param('id') id: string, @Req() req: any) {
    return this.recipes.archive(+id, req.user?.id || 1);
  }

  @Post('recipes/:id/restore')
  @RequirePermissions('recipes:archive')
  restore(@Param('id') id: string, @Req() req: any) {
    return this.recipes.restore(+id, req.user?.id || 1);
  }

  @Post('recipes/:id/clone')
  @RequirePermissions('recipes:clone')
  clone(@Param('id') id: string, @Body() dto: CloneRecipeDto, @Req() req: any) {
    return this.recipes.clone(+id, dto, req.user?.id || 1);
  }

  @Get('recipes/:id/comments')
  @RequirePermissions('recipes:view')
  comments(@Param('id') id: string) {
    return this.recipes.getComments(+id);
  }

  @Post('recipes/:id/comments')
  @RequirePermissions('recipes:comment')
  createComment(
    @Param('id') id: string,
    @Body() dto: CreateRecipeCommentDto,
    @Req() req: any,
  ) {
    return this.recipes.createComment(+id, dto, req.user.id);
  }

  @Patch('recipe-comments/:id')
  @RequirePermissions('recipes:comment')
  updateComment(
    @Param('id') id: string,
    @Body() dto: UpdateRecipeCommentDto,
    @Req() req: any,
  ) {
    return this.recipes.updateComment(+id, dto, req.user.id);
  }

  @Delete('recipe-comments/:id')
  @RequirePermissions('recipes:comment')
  deleteComment(@Param('id') id: string, @Req() req: any) {
    return this.recipes.deleteComment(+id, req.user.id);
  }

  @Get('recipes/:id/dependencies')
  @RequirePermissions('recipes:view')
  dependencies(@Param('id') id: string) {
    return this.recipes.getDependencies(+id);
  }

  @Post('recipes/:id/calculate-cost')
  @RequirePermissions('recipes:calculate_cost')
  calculateCost(
    @Param('id') id: string,
    @Body() dto: CalculateCostDto,
    @Req() req: any,
  ) {
    return this.recipes.calculateCost(+id, dto, req.user?.id || 1);
  }

  private async withCostPermission<T>(
    req: any,
    callback: (includeCost: boolean) => T | Promise<T>,
  ) {
    const user = req.user;
    if (!user?.id) return callback(false);
    if (user.roles?.includes('Super Admin')) return callback(true);
    const branchIdRaw = req.headers?.['x-branch-id'];
    const branchId = branchIdRaw ? Number(branchIdRaw) : undefined;
    let permissions = user.permissions || [];
    if (branchId && Number.isInteger(branchId)) {
      permissions =
        this.permissionCache.getBranch(user.id, branchId) ||
        (await this.authService.getPermissionsForBranch(user.id, branchId));
      this.permissionCache.setBranch(user.id, branchId, permissions);
    }
    return callback(permissions.includes('recipes:view_cost'));
  }
}
