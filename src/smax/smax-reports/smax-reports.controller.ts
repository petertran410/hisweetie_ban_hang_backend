import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../../auth/request-permissions';
import { SmaxSummaryQueryDto } from './smax-reports.dto';
import { SmaxReportActor, SmaxReportsService } from './smax-reports.service';

type AuthedRequest = {
  user: { id: number; canViewOtherStaffData?: boolean };
};

/**
 * Báo cáo Smax chat (/bao-cao/smax). Quyền xem riêng reports:smax (Cài đặt → Vai trò → Báo cáo).
 * Không xem dữ liệu NV khác → chỉ số liệu của mình; lead theo luật báo cáo Lead.
 */
@ApiTags('Reports - Smax')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports/smax')
export class SmaxReportsController {
  constructor(private readonly service: SmaxReportsService) {}

  private actor(req: AuthedRequest): SmaxReportActor {
    return {
      id: req.user.id,
      ownOnly: req.user.canViewOtherStaffData === false,
      leadsOwnOnly: !requestHasPermission(req, 'leads:update'),
    };
  }

  @Get('summary')
  @RequirePermissions('reports:smax')
  summary(@Query() q: SmaxSummaryQueryDto, @Req() req: AuthedRequest) {
    return this.service.summary(q, this.actor(req));
  }

  @Get('filter-options')
  @RequirePermissions('reports:smax')
  filterOptions(@Req() req: AuthedRequest) {
    return this.service.filterOptions(this.actor(req));
  }
}
