export interface DeviceInfo {
  browser: string;
  os: string;
  deviceType: 'mobile' | 'tablet' | 'desktop';
}

/**
 * Nhận diện gần đúng trình duyệt / hệ điều hành từ User-Agent để hiển thị
 * trong "Thiết bị đăng nhập". Không dùng cho mục đích bảo mật.
 */
export function describeUserAgent(ua?: string | null): DeviceInfo {
  const s = ua ?? '';

  const browser =
    (/coc_coc_browser/i.test(s) && 'Cốc Cốc') ||
    (/Edg(e|A|iOS)?\//.test(s) && 'Edge') ||
    (/(OPR|Opera)\//.test(s) && 'Opera') ||
    (/SamsungBrowser\//.test(s) && 'Samsung Internet') ||
    (/Zalo/i.test(s) && 'Zalo') ||
    (/FBAN|FBAV/.test(s) && 'Facebook') ||
    (/(Firefox|FxiOS)\//.test(s) && 'Firefox') ||
    (/(Chrome|CriOS)\//.test(s) && 'Chrome') ||
    (/Safari\//.test(s) && /Version\//.test(s) && 'Safari') ||
    'Trình duyệt khác';

  const os =
    (/iPad/.test(s) && 'iPadOS') ||
    (/iPhone|iPod/.test(s) && 'iOS') ||
    (/Android/.test(s) && 'Android') ||
    (/Windows NT/.test(s) && 'Windows') ||
    (/Mac OS X|Macintosh/.test(s) && 'macOS') ||
    (/CrOS/.test(s) && 'ChromeOS') ||
    (/Linux/.test(s) && 'Linux') ||
    'Không rõ';

  const deviceType: DeviceInfo['deviceType'] =
    /iPad|Tablet/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))
      ? 'tablet'
      : /Mobi|iPhone|iPod|Android/.test(s)
        ? 'mobile'
        : 'desktop';

  return { browser, os, deviceType };
}
