import { IsIn, IsString, Matches, MaxLength } from 'class-validator';

/** Expo push token: ExponentPushToken[xxx] (cũ) hoặc ExpoPushToken[xxx]. */
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

/** POST /push-devices — điện thoại đăng ký nhận thông báo đẩy. */
export class RegisterPushDeviceDto {
  @IsString()
  @MaxLength(200)
  @Matches(EXPO_TOKEN, { message: 'Push token không hợp lệ' })
  token: string;

  @IsIn(['ios', 'android'])
  platform: 'ios' | 'android';
}

/** POST /push-devices/unregister — đăng xuất thì ngừng nhận thông báo. */
export class UnregisterPushDeviceDto {
  @IsString()
  @MaxLength(200)
  @Matches(EXPO_TOKEN, { message: 'Push token không hợp lệ' })
  token: string;
}
