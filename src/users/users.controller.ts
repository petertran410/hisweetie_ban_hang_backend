import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @RequirePermissions('users.view')
  findAll(
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.findAll({
      search,
      branchId: branchId ? +branchId : undefined,
      isActive:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      page: page ? +page : 1,
      limit: limit ? +limit : 20,
    });
  }

  @Get(':id')
  @RequirePermissions('users.view')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(+id);
  }

  @Post()
  @RequirePermissions('users.create')
  create(@Body() data: any) {
    return this.usersService.create(data);
  }

  @Put(':id')
  @RequirePermissions('users.update')
  update(@Param('id') id: string, @Body() data: any) {
    return this.usersService.update(+id, data);
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  delete(@Param('id') id: string) {
    return this.usersService.delete(+id);
  }
}
