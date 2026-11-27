import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { guardLarkMessages, parseLarkAllowlist } from './lark-message-guard';

export const LARK_CLIENT = 'LARK_CLIENT';

export const LarkClientProvider: Provider = {
  provide: LARK_CLIENT,
  useFactory: (config: ConfigService) => {
    const appId = config.get<string>('LARK_APP_ID');
    const appSecret = config.get<string>('LARK_APP_SECRET');

    if (!appId || !appSecret) {
      throw new Error('LARK_APP_ID and LARK_APP_SECRET must be configured');
    }

    const client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Lark,
    });
    // Local/dev: chỉ gửi tin tới người trong LARK_MESSAGE_ALLOWLIST (production để trống)
    const allow = parseLarkAllowlist(
      config.get<string>('LARK_MESSAGE_ALLOWLIST'),
    );
    if (allow) guardLarkMessages(client, allow);
    return client;
  },
  inject: [ConfigService],
};
