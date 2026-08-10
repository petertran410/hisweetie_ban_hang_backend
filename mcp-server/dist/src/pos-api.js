import { config } from './config.js';
let token;
let tokenExpiresAt = 0;
async function getServiceToken() {
    if (token && Date.now() < tokenExpiresAt)
        return token;
    const response = await fetch(`${config.POS_API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: config.POS_SERVICE_EMAIL, password: config.POS_SERVICE_PASSWORD }),
    });
    if (!response.ok)
        throw new Error(`POS service login failed (${response.status})`);
    const body = await response.json();
    token = body.accessToken;
    tokenExpiresAt = Date.now() + 5 * 60_000;
    return token;
}
function queryString(query) {
    if (!query)
        return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '')
            continue;
        if (Array.isArray(value))
            value.forEach((item) => params.append(key, String(item)));
        else
            params.set(key, String(value));
    }
    const value = params.toString();
    return value ? `?${value}` : '';
}
export async function posRequest(method, path, options = {}) {
    const response = await fetch(`${config.POS_API_BASE_URL}${path}${queryString(options.query)}`, {
        method,
        headers: {
            Authorization: `Bearer ${await getServiceToken()}`,
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.branchId ? { 'X-Branch-Id': String(options.branchId) } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) {
        const message = Array.isArray(data?.message) ? data.message.join('; ') : data?.message;
        throw new Error(message || `POS API request failed (${response.status})`);
    }
    return data;
}
//# sourceMappingURL=pos-api.js.map