export type LarkOAuthConfig = {
  appId: string;
  appSecret: string;
  domain: string;
  redirectUri: string;
};

export type LarkUserProfile = {
  open_id: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  en_name?: string;
  email?: string;
  enterprise_email?: string;
  mobile?: string;
  avatar_url?: string;
  avatar_big?: string;
  tenant_key?: string;
};

type LarkTokenResponse = {
  access_token?: string;
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  data?: Record<string, unknown>;
};

function openApisBase(domain: string): string {
  return `https://open.${domain}/open-apis`;
}

function accountsBase(domain: string): string {
  return `https://accounts.${domain}`;
}

export function pickPreferredEmail(
  enterpriseEmail?: string | null,
  personalEmail?: string | null,
): string | null {
  const enterprise = (enterpriseEmail || '').trim().toLowerCase();
  if (enterprise) return enterprise;
  const personal = (personalEmail || '').trim().toLowerCase();
  if (personal) return personal;
  return null;
}

export function pickLarkDisplayName(
  profile: Pick<LarkUserProfile, 'name' | 'en_name' | 'email' | 'enterprise_email'>,
): string {
  const name = (profile.name || profile.en_name || '').trim();
  if (name) return name;
  const email = pickPreferredEmail(profile.enterprise_email, profile.email);
  if (email) return email.split('@')[0] || 'Lark User';
  return 'Lark User';
}

export function safeReturnTo(value: string | undefined, fallback = '/'): string {
  if (!value) return fallback;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return fallback;
}

export function buildAuthorizationUrl(config: LarkOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    app_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
  });
  return `${accountsBase(config.domain)}/open-apis/authen/v1/authorize?${params.toString()}`;
}

function unwrapTokenPayload(raw: LarkTokenResponse): LarkTokenResponse {
  if (raw.access_token) return raw;
  const data = raw.data as LarkTokenResponse | undefined;
  if (data?.access_token) return { ...raw, ...data };
  return raw;
}

function unwrapUserPayload(raw: Record<string, unknown>): LarkUserProfile {
  const data = (raw.data as Record<string, unknown> | undefined) ?? raw;
  const openId = String(data.open_id ?? data.sub ?? '').trim();
  if (!openId) {
    throw new Error('Lark user_info missing open_id');
  }
  return {
    open_id: openId,
    union_id: data.union_id ? String(data.union_id) : undefined,
    user_id: data.user_id ? String(data.user_id) : undefined,
    name: data.name ? String(data.name) : undefined,
    en_name: data.en_name ? String(data.en_name) : undefined,
    email: data.email ? String(data.email) : undefined,
    enterprise_email: data.enterprise_email
      ? String(data.enterprise_email)
      : undefined,
    mobile: data.mobile ? String(data.mobile) : undefined,
    avatar_url: data.avatar_url
      ? String(data.avatar_url)
      : data.picture
        ? String(data.picture)
        : undefined,
    avatar_big: data.avatar_big ? String(data.avatar_big) : undefined,
    tenant_key: data.tenant_key ? String(data.tenant_key) : undefined,
  };
}

export async function exchangeCode(
  config: LarkOAuthConfig,
  code: string,
): Promise<{ user: LarkUserProfile }> {
  const base = openApisBase(config.domain);

  const tokenRes = await fetch(`${base}/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: config.appId,
      client_secret: config.appSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`Token exchange HTTP ${tokenRes.status}: ${text}`);
  }

  const tokenJson = (await tokenRes.json()) as LarkTokenResponse;
  if (tokenJson.code != null && tokenJson.code !== 0) {
    throw new Error(
      tokenJson.error_description ||
        tokenJson.msg ||
        tokenJson.error ||
        'token exchange failed',
    );
  }

  const tokens = unwrapTokenPayload(tokenJson);
  if (!tokens.access_token) {
    throw new Error('Lark did not return a user access_token');
  }

  const userRes = await fetch(`${base}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!userRes.ok) {
    const text = await userRes.text().catch(() => '');
    throw new Error(`user_info HTTP ${userRes.status}: ${text}`);
  }

  const userJson = (await userRes.json()) as Record<string, unknown>;
  if (userJson.code != null && userJson.code !== 0) {
    throw new Error(String(userJson.msg ?? 'user info failed'));
  }

  return { user: unwrapUserPayload(userJson) };
}
