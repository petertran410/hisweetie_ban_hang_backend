import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CreatePlanningConfigDto,
  RecommendationQueryDto,
  ResolvedPlanningConfigQueryDto,
  RunCalculationDto,
  UpdatePlanningConfigDto,
} from '../dto';
import { PurchasingPlanningService } from '../services/purchasing-planning.service';
import { PlanningNetworkService } from '../services/planning-network.service';
import { UpdatePlanningNetworkConfigDto } from '../dto/planning-network-config.dto';

type AuthenticatedUser = {
  id: number;
  name?: string | null;
  email?: string | null;
};

@ApiTags('Purchasing Planning')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('purchasing-planning')
export class PurchasingPlanningController {
  constructor(
    private readonly service: PurchasingPlanningService,
    private readonly networkService: PlanningNetworkService,
  ) {}

  @Get('network-config')
  @RequirePermissions('purchasing_planning:config')
  async getNetworkConfig() {
    return this.networkService.getRawConfig();
  }

  @Patch('network-config')
  @RequirePermissions('purchasing_planning:config')
  updateNetworkConfig(@Body() dto: UpdatePlanningNetworkConfigDto) {
    return this.networkService.updateConfig(dto);
  }

  @Get('configs')
  @RequirePermissions('purchasing_planning:config')
  getConfigs() {
    return this.service.getConfigs();
  }

  @Get('configs/resolved')
  @RequirePermissions('purchasing_planning:config')
  getResolvedConfig(@Query() query: ResolvedPlanningConfigQueryDto) {
    return this.service.getResolvedConfig(query);
  }

  @Post('configs')
  @RequirePermissions('purchasing_planning:config')
  createConfig(
    @Body() dto: CreatePlanningConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.createConfig(dto, this.actor(user));
  }

  @Patch('configs/:id')
  @RequirePermissions('purchasing_planning:config')
  updateConfig(
    @Param('id') id: string,
    @Body() dto: UpdatePlanningConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.updateConfig(id, dto, this.actor(user));
  }

  @Delete('configs/:id')
  @RequirePermissions('purchasing_planning:config')
  deleteConfig(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.deleteConfig(id, this.actor(user));
  }

  @Get('recommendations')
  @RequirePermissions('purchasing_planning:view')
  getRecommendations(@Query() query: RecommendationQueryDto) {
    return this.service.getRecommendations(query);
  }

  @Get('recommendations/:itemId')
  @RequirePermissions('purchasing_planning:view')
  getRecommendationDetail(@Param('itemId', ParseIntPipe) itemId: number) {
    return this.service.getRecommendationDetail(itemId);
  }

  @Post('calculations/run')
  @RequirePermissions('purchasing_planning:run')
  runCalculation(
    @Body() dto: RunCalculationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.service.runCalculation(dto, user.id);
  }

  private actor(user: AuthenticatedUser) {
    return {
      id: user.id,
      name: user.name || user.email || 'System',
    };
  }
}
