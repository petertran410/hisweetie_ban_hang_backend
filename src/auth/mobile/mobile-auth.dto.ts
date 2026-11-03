import { IsString, Matches, MaxLength } from 'class-validator';

/** Refresh token app giữ trong Keychain (32 byte base64url = 43 ký tự). */
export class MobileRefreshDto {
  @IsString()
  @MaxLength(256)
  refreshToken: string;
}

/** Mã một lần Lark trả về app + code_verifier PKCE app tự sinh. */
export class MobileLarkExchangeDto {
  @IsString()
  @MaxLength(4096)
  code: string;

  @IsString()
  @Matches(/^[A-Za-z0-9._~-]{43,128}$/, {
    message: 'code_verifier không hợp lệ',
  })
  codeVerifier: string;
}
