import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BranchesService } from './branches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('branches')
export class BranchesController {
  constructor(private branchesService: BranchesService) {}

  @Get()
  @RequirePermissions('branches:view')
  findAll(
    @Query('search') search?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchesService.findAll({
      search,
      isActive:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      page: page ? +page : 1,
      limit: limit ? +limit : 20,
    });
  }

  @Get('my-branches')
  @ApiOperation({
    summary: 'Get branches assigned to current user (no permission required)',
  })
  async getMyBranches(@Req() req: any) {
    const user = req.user;
    const branchIds: number[] = user.branchIds || [];

    if (branchIds.length === 0) {
      return this.branchesService.findAll();
    }

    return this.branchesService.findByIds(branchIds);
  }

  @Get('all')
  @RequirePermissions('branches:view')
  @ApiOperation({ summary: 'Get all branches as array' })
  async getAllBranches() {
    const result = await this.branchesService.findAll();
    return result.data;
  }

  @Get(':id')
  @RequirePermissions('branches:view')
  findOne(@Param('id') id: string) {
    return this.branchesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('branches:create')
  create(@Body() data: any, @CurrentUser() user: any) {
    return this.branchesService.create(data, user.id);
  }

  @Put(':id')
  @RequirePermissions('branches:update')
  update(@Param('id') id: string, @Body() data: any, @CurrentUser() user: any) {
    return this.branchesService.update(+id, data, user.id);
  }

  @Delete(':id')
  @RequirePermissions('branches:delete')
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.branchesService.delete(+id, user.id);
  }
}
