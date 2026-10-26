import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RealtimeModule } from './realtime.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionCacheModule } from '../permission-cache/permission-cache.module';
import { LARK_CLIENT } from '../lark-sync/lark-client.provider';
import { ScheduleModule } from '@nestjs/schedule';

describe('Realtime module wiring (no DB or network)', () => {
  const prev = process.env.JWT_SECRET;
  beforeAll(() => (process.env.JWT_SECRET = 'wiring-test-secret'));
  afterAll(() => (process.env.JWT_SECRET = prev));

  it('resolves gateway + service with AuthModule dependencies', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PermissionCacheModule,
        ScheduleModule.forRoot(),
        RealtimeModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({ $disconnect: jest.fn() })
      .overrideProvider(LARK_CLIENT)
      .useValue({})
      .compile();

    expect(module.get(RealtimeGateway)).toBeDefined();
    expect(module.get(RealtimeService)).toBeDefined();
    await module.close();
  });
});
