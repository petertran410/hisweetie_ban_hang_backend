import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { InternalFundModule } from './internal-fund.module';
import { InternalFundService } from './internal-fund.service';
import { InternalFundLedgerService } from './internal-fund-ledger.service';
import {
  InternalFundController,
  InternalFundApprovalController,
} from './internal-fund.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { GoogleStrategy } from '../auth/strategies/google.strategy';
import { ScheduleModule } from '@nestjs/schedule';

describe('Internal fund module wiring (no DB or network)', () => {
  it('resolves controllers, permissions and ledger without circular dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PermissionCacheModule,
        ScheduleModule.forRoot(),
        InternalFundModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ $disconnect: jest.fn() })
      .overrideProvider(AuthService)
      .useValue({ getPermissionsForBranch: jest.fn() })
      .overrideProvider(LARK_CLIENT)
      .useValue({})
      .overrideProvider(GoogleStrategy)
      .useValue({})
      .compile();
    expect(module.get(InternalFundService)).toBeDefined();
    expect(module.get(InternalFundLedgerService)).toBeDefined();
    expect(module.get(InternalFundController)).toBeDefined();
    expect(module.get(InternalFundApprovalController)).toBeDefined();
    await module.close();
  });
});
