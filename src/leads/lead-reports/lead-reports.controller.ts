import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../../auth/decorators/permissions.decorator';
import { requestHasPermission } from '../../auth/request-permissions';
import { LeadReportActor } from './lead-reports.calc';
import { LeadSummaryQueryDto } from './lead-reports.dto';
import { LeadReportsService } from './lead-reports.service';

type AuthedRequest = { user: { id: number } };

/** Dashboard Lead (/bao-cao/lead). Quyền và phạm vi dữ liệu giống GET /leads. */
@ApiTags('Reports - Leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports/leads')
export class LeadReportsController {
  constructor(private readonly service: LeadReportsService) {}

  // Chỉ có leads:view (Sale) → chỉ số liệu lead giao cho mình; leads:update (CSKH) → mọi lead
  private actor(req: AuthedRequest): LeadReportActor {
    return {
      id: req.user.id,
      ownOnly: !requestHasPermission(req, 'leads:update'),
    };
  }

  @Get('summary')
  @RequirePermissions('leads:view')
  summary(@Query() q: LeadSummaryQueryDto, @Req() req: AuthedRequest) {
    return this.service.summary(q, this.actor(req));
  }

  @Get('filter-options')
  @RequirePermissions('leads:view')
  filterOptions(@Req() req: AuthedRequest) {
    return this.service.filterOptions(this.actor(req));
  }
}
