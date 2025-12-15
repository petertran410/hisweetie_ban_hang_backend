import { Controller, Get, UseGuards } from '@nestjs/common';
import { BranchesService } from './branches.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Branches')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('branches')
export class BranchesController {
  constructor(private branchesService: BranchesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all branches' })
  findAll() {
    return this.branchesService.findAll();
  }

  @Get('my-branches')
  @ApiOperation({ summary: 'Get branches accessible by current user' })
  async getMyBranches(@CurrentUser() user: any) {
    return this.branchesService.findByUser(user.id);
  }
}
