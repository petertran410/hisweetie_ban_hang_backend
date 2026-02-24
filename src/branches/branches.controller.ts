import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
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
  @RequirePermissions('branches.view')
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
  @ApiOperation({ summary: 'Get branches accessible by current user' })
  async getMyBranches(@CurrentUser() user: any) {
    return this.branchesService.findByUser(user.id);
  }

  @Get(':id')
  @RequirePermissions('branches.view')
  findOne(@Param('id') id: string) {
    return this.branchesService.findOne(+id);
  }

  @Post()
  @RequirePermissions('branches.create')
  create(@Body() data: any) {
    return this.branchesService.create(data);
  }

  @Put(':id')
  @RequirePermissions('branches.update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.branchesService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermissions('branches.delete')
  delete(@Param('id') id: string) {
    return this.branchesService.delete(+id);
  }
}
