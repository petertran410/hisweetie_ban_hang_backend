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
  Req,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Get all users with filters' })
  findAll(
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('isActive') isActive?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.usersService.findAll({
      search,
      branchId: branchId ? parseInt(branchId) : undefined,
      isActive:
        isActive === 'true' ? true : isActive === 'false' ? false : undefined,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get('all')
  @ApiOperation({ summary: 'Get all active users (simplified)' })
  getUsers() {
    return this.usersService.getUsers();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(parseInt(id));
  }

  @Post()
  @ApiOperation({ summary: 'Create new user' })
  create(
    @Body()
    data: {
      name: string;
      email: string;
      password: string;
      phone?: string;
      branchId?: number;
      roleIds?: number[];
      permissionIds?: number[];
      isActive?: boolean;
    },
  ) {
    return this.usersService.create(data);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update user' })
  update(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      email?: string;
      password?: string;
      phone?: string;
      branchId?: number;
      isActive?: boolean;
      roleIds?: number[];
      permissionIds?: number[];
    },
  ) {
    return this.usersService.update(parseInt(id), data);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete user' })
  delete(@Param('id') id: string) {
    return this.usersService.delete(parseInt(id));
  }

  @Put(':id/permissions')
  @ApiOperation({ summary: 'Assign permissions to user' })
  assignPermissions(
    @Param('id') id: string,
    @Body() data: { permissionIds: number[] },
  ) {
    return this.usersService.assignPermissions(
      parseInt(id),
      data.permissionIds,
    );
  }
}
