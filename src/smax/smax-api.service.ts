import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/** user = token đăng nhập Smax (SMAX_USER_TOKEN, API nội bộ app Smax); api = Partner API token (SMAX_API_TOKEN). */
export type SmaxTokenKind = 'user' | 'api';

export interface SmaxTokenCheck {
  ok: boolean;
  // Smax từ chối token (401/403)
  invalid?: boolean;
  message?: string;
  // Token dùng được nhưng có vấn đề (vd thiếu quyền / Smax trả 0 hội thoại)
  warning?: string;
}

/** Kênh (page) đã kết nối trên Smax — chỉ giữ các field POS cần. */
export interface SmaxPage {
  pid: string;
  name: string;
  // Ảnh đại diện tài khoản Zalo / OA của kênh
  picture: string | null;
  platform: string;
  active: boolean;
  /**
   * Lỗi kết nối (token Zalo hết hạn / mất phiên) — Smax ghi ở
   * members[].access_token_error; `active` vẫn true nên phải đọc riêng.
   */
  connectionError: { at: string; note: string | null } | null;
}

/** Hội thoại (thread) trên Smax (mọi kênh) — chỉ field POS cần. */
export interface SmaxThread {
  tid: string;
  // zaloweb, zalo (OA), facebook, instagram, tiktokweb, shopee, custom (website)…
  platform: string;
  name: string;
  // Smax báo trả lời được qua API (can_reply_message); Facebook/Shopee hay là false
  canReply: boolean;
  // Bình luận bài viết (Facebook…): link bài viết, kèm comment_id để Facebook cuộn tới bình luận
  isComment: boolean;
  commentUrl: string | null;
  // Ai đang trả lời hội thoại Messenger: META_AI (Meta Business AI), SMAXAI (Smax/nhân viên), OTHER…
  controlledBy: string | null;
  chatType: 'private' | 'group' | string;
  /** pid → tên (thành viên nhóm / khách), để hiện người gửi. */
  members: Record<string, string>;
  /** pid → ảnh đại diện (nếu Smax có). */
  memberAvatars: Record<string, string>;
  avatar: string | null;
  memberCount: number;
  // Tối đa 4 thành viên (theo thứ tự Smax) để ghép avatar nhóm kiểu Zalo
  memberPreview: { name: string | null; avatar: string | null }[];
  // SĐT Smax thu được trong hội thoại
  phones: string[];
}

/** Tin nhắn thô Smax trả về (Partner API). */
/** Nội dung 1 lần gọi zaloweb-messages; image/images/file là URL công khai Smax tải được. */
export interface ZalowebContent {
  message?: string;
  images?: string[];
  file?: string;
  stickerId?: string;
}

/** 1 phần tin gửi vào thread (mọi kênh) — URL công khai Smax tải được. */
export interface ThreadMessagePart {
  message?: string;
  picture?: string;
  video?: string;
  file?: string;
  // Messenger: HUMAN_AGENT = nhân viên trả lời → lấy lại quyền từ Meta Business AI
  message_tag?: string;
}

export const GROUP_SCAN_LIMIT = 500;

export interface SmaxGroupThread {
  zaloId: string;
  name: string;
  // pid thành viên ("zlw" + uid), bỏ "zlw0" (bản ghi giữ chỗ của Smax)
  memberPids: string[];
  lastMessageAt: string | null;
  avatar: string | null;
  // Tối đa 4 thành viên để ghép avatar nhóm kiểu Zalo
  memberPreview: { name: string | null; avatar: string | null }[];
}

export interface SmaxRecentThread {
  tid: string;
  pagePid: string;
  platform: string;
  // Hội thoại bình luận bài viết (Smax type "facebook_comment"…), khác tin nhắn (Messenger…)
  isComment: boolean;
  // Messenger: META_AI = Meta Business AI đang trả lời
  controlledBy: string | null;
  name: string;
  canReply: boolean;
  // SĐT khách Smax thu được (Facebook…) — để gợi ý khách POS
  phones: string[];
  isGroup: boolean;
  lastMessage: string;
  lastMessageAt: string | null;
  unread: boolean;
  // Tổng số tin của thread (Smax reply_count) — client tính "tin mới" theo chênh lệch
  messageCount: number;
  avatar: string | null;
  memberPreview: { name: string | null; avatar: string | null }[];
}

export interface SmaxFriendStatus {
  isFriend: boolean;
  isRequested: boolean;
  isRequesting: boolean;
}

export interface SmaxRawMessage {
  id: string;
  pid: string;
  type: string;
  // zaloweb, zalo, facebook, shopee… — phần riêng của nền tảng nằm ở m[platform]
  platform?: string;
  message?: string;
  sender_pid?: string;
  created_at: string;
  // Chỉ API nội bộ Smax có (Partner API không trả): "deleted" = đã thu hồi; deleted.at = đã xoá phía mình
  status?: string;
  deleted?: { at?: string } | null;
  zaloweb?: {
    // Ảnh/video gửi cùng lượt (album) có chung mã này
    group_layout_id?: string;
    // Tin sticker: chỉ có mã, ảnh lấy từ máy chủ sticker công khai của Zalo
    sticker_id?: string;
    // Tin trả lời: trích tin gốc
    quote?: { global_msg_id?: string; msg?: string; reply_to_name?: string };
    // Cảm xúc theo từng người thả (icons: HEART, LIKE, HAHA, CRY…; number = số lần bấm)
    customer_reactions?: {
      customer_pid?: string;
      customer_name?: string;
      customer_picture?: string;
      icons?: { name?: string; number?: number }[];
    }[];
    attachments?: {
      url?: string;
      thumbnail?: string;
      title?: string;
      type?: string;
      // Facebook/Instagram: mime_type ("image", "image/png", "video/mp4"…), url_preview, name
      mime_type?: string;
      url_preview?: string;
      name?: string;
    }[];
  };
  // Facebook: tin sticker có URL ảnh sticker (kèm 1 attachment trùng ảnh đó)
  facebook?: { sticker?: string };
}

/**
 * Client Smax.AI Partner API (https://api.smax.ai, Bearer token của Business).
 * Tài liệu: https://smax.ai/api/partner/docs
 */
@Injectable()
export class SmaxApiService {
  private readonly logger = new Logger(SmaxApiService.name);
  private readonly baseUrl: string;
  readonly bizAlias: string;
  // api: Partner API token của Business; user: token đăng nhập 1 tài khoản Smax (JWT) — chỉ dùng cho
  // API nội bộ Partner API chưa có (thả cảm xúc…). Ưu tiên token lưu trên POS (/cai-dat/smax,
  // SmaxService nạp lúc khởi động), không có thì .env
  private readonly envTokens: Record<SmaxTokenKind, string | undefined>;
  private readonly tokens: Record<SmaxTokenKind, string | undefined> = { user: undefined, api: undefined };
  readonly tokenSources: Record<SmaxTokenKind, 'db' | 'env' | null> = { user: null, api: null };

  private get token() {
    return this.tokens.api;
  }

  private get userToken() {
    return this.tokens.user;
  }

  constructor(
    private readonly http: HttpService,
    config: ConfigService,
  ) {
    this.baseUrl = config
      .get<string>('SMAX_API_URL', 'https://api.smax.ai')
      .replace(/\/+$/, '');
    this.bizAlias = config.get<string>('SMAX_BIZ_ALIAS', 'dieptra');
    this.envTokens = {
      api: config.get<string>('SMAX_API_TOKEN')?.trim() || undefined,
      user: config.get<string>('SMAX_USER_TOKEN')?.trim() || undefined,
    };
    this.useStoredToken('api', null);
    this.useStoredToken('user', null);
  }

  /** Dùng token lưu trên POS; null = bỏ, quay về token trong .env. */
  useStoredToken(kind: SmaxTokenKind, token: string | null) {
    this.tokens[kind] = token || this.envTokens[kind];
    this.tokenSources[kind] = token ? 'db' : this.envTokens[kind] ? 'env' : null;
  }

  /** Token đang dùng (chỉ để kiểm tra / hiện vài ký tự cuối ở trang cấu hình — không trả nguyên ra ngoài). */
  activeToken(kind: SmaxTokenKind): string | undefined {
    return this.tokens[kind];
  }

  hasEnvToken(kind: SmaxTokenKind): boolean {
    return !!this.envTokens[kind];
  }

  /**
   * Thử token bằng API chỉ đọc. user: album Thư viện (API nội bộ); api: danh sách kênh, rồi lấy thử
   * 1 hội thoại (quyền GET_LIST_THREAD) — dùng được nhưng không ra hội thoại nào thì cảnh báo.
   * invalid = Smax từ chối token (401/403); lỗi khác (mạng, 5xx) = chưa kết luận được.
   */
  async checkToken(kind: SmaxTokenKind, token = this.tokens[kind]): Promise<SmaxTokenCheck> {
    if (!token) return { ok: false, message: 'Chưa có token' };
    const headers = { Authorization: `Bearer ${token}` };
    try {
      if (kind === 'user') {
        await firstValueFrom(
          this.http.get(`${this.baseUrl}/bizs/${this.bizAlias}/groups?type=STORAGE`, { headers, timeout: 15000 }),
        );
        return { ok: true };
      }
      const res = await firstValueFrom(
        this.http.get(`${this.baseUrl}/partner/bizs/${this.bizAlias}/pages`, { headers, timeout: 15000 }),
      );
      const pages: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
      const pids = pages.map((p) => String(p?.pid ?? p?.page_pid ?? '')).filter(Boolean);
      if (!pids.length) return { ok: true, warning: 'Token dùng được nhưng Smax không trả kênh nào' };
      return { ok: true, warning: await this.threadListWarning(headers, pids) };
    } catch (error: any) {
      const status = error?.response?.status;
      const smaxMessage = error?.response?.data?.message;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          invalid: true,
          message: `Token không hợp lệ hoặc đã hết hạn${typeof smaxMessage === 'string' && smaxMessage.trim() ? ` (Smax: ${smaxMessage.trim()})` : ''}`,
        };
      }
      return { ok: false, message: `Không kiểm tra được với Smax (${status ?? error?.code ?? 'lỗi mạng'}) — thử lại sau` };
    }
  }

  // Danh sách hội thoại (khung chat "Đang chat gần đây") cần quyền GET_LIST_THREAD và phải ra dữ liệu
  private async threadListWarning(headers: Record<string, string>, pagePids: string[]): Promise<string | undefined> {
    try {
      const res = await firstValueFrom(
        this.http.post(
          `${this.baseUrl}/partner/bizs/${this.bizAlias}/threads/threads`,
          { page_pids: pagePids, limit: 1 },
          { headers, timeout: 30000 },
        ),
      );
      const rows: unknown[] = res.data?.data ?? [];
      return rows.length
        ? undefined
        : 'Smax trả 0 hội thoại cho token này — danh sách hội thoại trong khung chat sẽ trống';
    } catch (error: any) {
      const status = error?.response?.status;
      return status === 403
        ? 'Token thiếu quyền GET_LIST_THREAD — danh sách hội thoại trong khung chat không tải được'
        : `Không lấy thử được danh sách hội thoại (${status ?? error?.code ?? 'lỗi mạng'})`;
    }
  }

  /** Thả cảm xúc được không (đã cấu hình SMAX_USER_TOKEN). */
  get canReact(): boolean {
    return !!this.userToken;
  }

  /**
   * Thả / thu hồi cảm xúc tin Zalo (reaction NONE = thu hồi) qua API nội bộ của app Smax
   * (Partner API không có). Thả với tư cách tài khoản Zalo của kênh.
   */
  async reactMessage(pagePid: string, tid: string, pid: string, reaction: string): Promise<void> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa thả cảm xúc được');
    }
    await this.request(
      'POST',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages/${pid}/reaction`,
      { reaction },
      { token: this.userToken },
    );
  }

  /**
   * Chuyển quyền trả lời hội thoại Messenger cho Meta Business AI, qua API nội bộ của app Smax
   * (nút "Pass control to Meta Business AI"; Partner API không có).
   */
  async passControlBizAI(pagePid: string, tid: string): Promise<void> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa bật Meta Business AI được');
    }
    await this.request(
      'POST',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/pass-control-biz-ai`,
      {},
      { token: this.userToken },
    );
  }

  /**
   * Thu hồi (cả 2 phía, tin của kênh, trong 24 giờ) / xoá phía mình 1 tin Zalo
   * qua API nội bộ của app Smax (Partner API không có).
   */
  async messageAction(pagePid: string, tid: string, pid: string, action: 'recall' | 'delete'): Promise<void> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa thu hồi / xoá tin được');
    }
    await this.request(
      'POST',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages/${pid}/${action}`,
      {},
      { token: this.userToken },
    );
  }

  /**
   * Đổi tên khách / nhóm trên Smax (= tên hội thoại, nút sửa tên trong Smax) qua API nội bộ
   * (Partner API không có). Zalo cá nhân: customer pid = tid; Smax lưu luôn làm tên gợi nhớ của kênh.
   */
  async renameCustomer(pagePid: string, customerPid: string, name: string): Promise<string> {
    if (!this.userToken) {
      throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa đổi tên được');
    }
    const body = await this.request(
      'PUT',
      `/bizs/${this.bizAlias}/pages/${pagePid}/customers/${customerPid}/info`,
      { name },
      { token: this.userToken },
    );
    return body?.data?.name ?? name;
  }

  /** Album của Thư viện Smax (groups type STORAGE, API nội bộ). */
  async listStorageAlbums(): Promise<{ id: string; name: string; count: number | null; picture: string | null }[]> {
    if (!this.userToken) throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa mở được Thư viện Smax');
    const body = await this.request('GET', `/bizs/${this.bizAlias}/groups?type=STORAGE`, undefined, { token: this.userToken });
    const rows: any[] = body?.data ?? [];
    return rows
      .filter((g) => g?.type === 'STORAGE' && typeof g.id === 'string')
      .map((g) => ({ id: g.id, name: g.name ?? '', count: typeof g.number === 'number' ? g.number : null, picture: g.picture ?? null }));
  }

  /** Tệp trong Thư viện Smax, mới → cũ; cursor = mốc created_at (ms) của tệp cuối trang trước. */
  async listStorage(q: { name?: string; type?: string; groupId?: string; cursor?: number; limit: number }): Promise<any[]> {
    if (!this.userToken) throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa mở được Thư viện Smax');
    const params = new URLSearchParams({ limit: String(q.limit), name: q.name ?? '' });
    if (q.type) params.set('type', q.type);
    if (q.groupId) params.set('group_id', q.groupId);
    // Smax viết sai chính tả tham số phân trang: "cusor"
    if (q.cursor) params.set('cusor', String(q.cursor));
    const body = await this.request('GET', `/bizs/${this.bizAlias}/storages?${params}`, undefined, { token: this.userToken });
    return body?.data ?? [];
  }

  /** Tải tệp lên Thư viện Smax (như nút "Tải lên" trên Smax); albumId = group STORAGE. */
  async uploadStorage(files: { buffer: Buffer; name: string; mime: string }[], albumId?: string): Promise<any[]> {
    if (!this.userToken) throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa sửa được Thư viện Smax');
    const form = new FormData();
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.buffer)], { type: f.mime }), f.name);
    if (albumId) form.append('group_id', albumId);
    form.append('private', 'true');
    const body = await this.request('POST', `/bizs/${this.bizAlias}/storages/uploads`, form, {
      token: this.userToken,
      timeout: 120_000,
    });
    return body?.data ?? [];
  }

  /** Xoá tệp khỏi Thư viện Smax (xoá hẳn cho cả doanh nghiệp). */
  async deleteStorage(ids: string[]): Promise<void> {
    if (!this.userToken) throw new ServiceUnavailableException('Chưa cấu hình SMAX_USER_TOKEN — chưa sửa được Thư viện Smax');
    await this.request('DELETE', `/bizs/${this.bizAlias}/storages`, { ids }, { token: this.userToken });
  }

  /**
   * Tên gợi nhớ Sale đặt trên app Zalo của kênh (Smax tự đồng bộ từ Zalo): customer pid → tên.
   * Không có token → rỗng.
   */
  async getZaloAliases(pagePid: string): Promise<Map<string, string>> {
    if (!this.userToken) return new Map();
    const body = await this.request(
      'GET',
      `/bizs/${this.bizAlias}/pages/${pagePid}/zaloweb-alias`,
      undefined,
      { allow404: true, token: this.userToken },
    );
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? []);
    return new Map(
      rows
        .filter((r) => typeof r?.customer_pid === 'string' && typeof r?.name === 'string' && r.name.trim())
        .map((r) => [r.customer_pid, r.name.trim()]),
    );
  }

  /**
   * Trạng thái thu hồi / xoá của đúng trang tin như getMessages (cùng 20 tin, `cusor` = `before`),
   * lấy qua API nội bộ. Không có token → null.
   */
  async getMessageStates(
    pagePid: string,
    tid: string,
    before?: string,
  ): Promise<Map<string, Pick<SmaxRawMessage, 'status' | 'deleted'>> | null> {
    if (!this.userToken) return null;
    const qs = before
      ? `?${new URLSearchParams({ limit: '20', sort: '-created_at', cusor: before })}`
      : '';
    const body = await this.request(
      'GET',
      `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages${qs}`,
      undefined,
      { allow404: true, token: this.userToken },
    );
    const rows: SmaxRawMessage[] = Array.isArray(body) ? body : (body?.data ?? []);
    return new Map(rows.map((m) => [m.pid, { status: m.status, deleted: m.deleted }]));
  }

  async listPages(): Promise<SmaxPage[]> {
    const body = await this.get(`/partner/bizs/${this.bizAlias}/pages`);
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? []);
    return rows.map((p) => ({
      pid: String(p.pid ?? p.page_pid ?? ''),
      name: p.name ?? '',
      picture: p.picture ?? p.zaloweb?.picture ?? null,
      platform: p.platform ?? '',
      active: p.active !== false,
      connectionError: this.connectionError(p),
    }));
  }

  /**
   * Kênh mất kết nối khi KHÔNG còn thành viên nào có token tốt. Zalo OA có
   * thể có nhiều admin: token cũ của 1 admin lỗi không làm kênh ngừng nếu
   * admin khác còn token hợp lệ (Smax vẫn dùng admin đó).
   */
  private connectionError(p: any): SmaxPage['connectionError'] {
    const members: any[] = Array.isArray(p.members) ? p.members : [];
    if (!members.length || members.some((m) => !m?.access_token_error)) {
      return null;
    }
    const latest = members.reduce((a, b) =>
      new Date(b.access_token_error) > new Date(a.access_token_error) ? b : a,
    );
    return {
      at: String(latest.access_token_error),
      note: latest.access_token_error_note ?? null,
    };
  }

  /**
   * Hội thoại theo tid; null nếu chưa có trên Smax. Partner API lỗi 500 với một số thread
   * (Smax "Cannot read properties of undefined (reading 'id')") → đọc lại qua API nội bộ
   * (cùng cấu trúc), không ghi log lỗi Partner mỗi lần tải tin.
   */
  async getThread(pagePid: string, tid: string): Promise<SmaxThread | null> {
    let body: any;
    try {
      body = await this.request(
        'GET',
        `/partner/bizs/${this.bizAlias}/threads/pages/${pagePid}/threads/${tid}`,
        undefined,
        { allow404: true, silent: !!this.userToken },
      );
    } catch (error) {
      if (!this.userToken) throw error;
      body = await this.request(
        'GET',
        `/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}`,
        undefined,
        { allow404: true, token: this.userToken },
      );
    }
    const t = body?.data ?? body;
    if (!t?.tid) return null;
    const isComment = /_comment$/.test(t.type ?? '');
    const postLink: string | null =
      typeof t.facebook?.link === 'string' && /^https:\/\/(www\.)?facebook\.com\//.test(t.facebook.link)
        ? t.facebook.link
        : null;
    // facebook.id của thread bình luận = "<post>_<comment>"
    const commentId = /^\d+_(\d+)$/.exec(String(t.facebook?.id ?? ''))?.[1];
    const members: Record<string, string> = {};
    const memberAvatars: Record<string, string> = {};
    for (const c of t.customers ?? []) {
      if (c?.pid && c?.name) members[c.pid] = c.name;
      if (c?.pid && c?.picture) memberAvatars[c.pid] = c.picture;
    }
    return {
      tid: t.tid,
      platform: t.platform ?? '',
      name: t.customer?.name ?? t.zaloweb?.name ?? '',
      canReply: t.can_reply_message !== false,
      isComment,
      controlledBy: typeof t.controlled_by === 'string' ? t.controlled_by : null,
      commentUrl:
        isComment && postLink
          ? commentId
            ? `${postLink}${postLink.includes('?') ? '&' : '?'}comment_id=${commentId}`
            : postLink
          : null,
      chatType: t.zaloweb?.chat_type ?? t.zalo?.chat_type ?? '',
      members,
      memberAvatars,
      avatar: t.customer?.picture ?? t.customer?.zaloweb?.picture ?? null,
      memberCount: (t.customer_pids ?? []).filter((p: string) => p !== 'zlw0').length,
      memberPreview: memberPreview(t),
      phones: (t.phones ?? []).filter((p: unknown): p is string => typeof p === 'string'),
    };
  }

  /**
   * Các nhóm Zalo kênh đang tham gia, kèm thành viên. Smax không phân trang
   * được (cursor/before bị bỏ qua) → chỉ lấy tối đa 500 nhóm có tin gần nhất.
   * Response rất nặng (~20KB/nhóm, ~15s cho 470 nhóm) — nơi gọi nên cache.
   */
  async listGroupThreads(pagePid: string): Promise<SmaxGroupThread[]> {
    const body = await this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/threads/threads`,
      { page_pids: [pagePid], is_group: 'true', limit: GROUP_SCAN_LIMIT },
      { timeout: 60000 },
    );
    return (body?.data ?? [])
      .filter((t: any) => t?.tid?.startsWith('zlw'))
      .map((t: any) => ({
        zaloId: t.tid.slice(3),
        name: t.customer?.name ?? t.customer?.zaloweb?.name ?? '',
        memberPids: (t.customer_pids ?? []).filter((p: string) => p !== 'zlw0'),
        lastMessageAt: t.last_message_at ?? null,
        avatar: t.customer?.picture ?? null,
        memberPreview: memberPreview(t),
      }));
  }

  /** Hội thoại mới nhất của các kênh, mọi nền tảng (mới → cũ). Response nặng (~20KB/thread) → nơi gọi nên cache. */
  async listRecentThreads(pagePids: string[], limit = 30, keyword?: string): Promise<SmaxRecentThread[]> {
    const body = await this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/threads/threads`,
      // keyword: Smax tìm trên mọi hội thoại (tên khách/nhóm, cả thành viên & nội dung) — ~2-3s
      { page_pids: pagePids, limit, ...(keyword ? { keyword } : {}) },
      { timeout: 30000 },
    );
    return (body?.data ?? [])
      .filter((t: any) => t?.tid && t?.page_pid)
      .map((t: any) => ({
        tid: t.tid,
        pagePid: t.page_pid,
        platform: t.platform ?? '',
        isComment: /_comment$/.test(t.type ?? ''),
        controlledBy: typeof t.controlled_by === 'string' ? t.controlled_by : null,
        name: t.customer?.name ?? t.customer?.zaloweb?.name ?? '',
        canReply: t.can_reply_message !== false,
        phones: (t.phones ?? []).filter((p: unknown): p is string => typeof p === 'string'),
        isGroup:
          t.zaloweb?.chat_type === 'group' ||
          t.customer?.zaloweb?.chat_type === 'group' ||
          t.zalo?.chat_type === 'group',
        // Tin cuối: "attach" = tệp/ảnh
        lastMessage: typeof t.message === 'string' ? t.message : '',
        lastMessageAt: t.last_message_at ?? null,
        unread: t.read === false,
        messageCount: Number(t.reply_count ?? 0),
        avatar: t.customer?.picture ?? t.customer?.zaloweb?.picture ?? null,
        memberPreview: memberPreview(t),
      }));
  }

  /** 20 tin mới nhất (Smax cố định 20/lần); `before` = created_at tin cũ nhất đã có. */
  async getMessages(
    pagePid: string,
    tid: string,
    before?: string,
  ): Promise<SmaxRawMessage[]> {
    // before = created_at (ISO) của tin cũ nhất đã có; Smax trả 20 tin trước mốc đó
    const qs = before ? `?before=${encodeURIComponent(before)}` : '';
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages${qs}`,
      undefined,
      { allow404: true },
    );
    return Array.isArray(body) ? body : (body?.data ?? []);
  }

  /** Gửi tin từ kênh Zalo cá nhân tới người dùng (uid) hoặc nhóm (grid). */
  async sendZaloweb(
    pagePid: string,
    to: { uid: string } | { grid: string },
    content: ZalowebContent,
  ): Promise<any> {
    return this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/zaloweb-messages`,
      { ...to, ...content },
      // Smax tự tải media từ URL rồi đẩy lên Zalo → lâu hơn tin chữ
      { timeout: content.message && Object.keys(content).length === 1 ? 15000 : 60000 },
    );
  }

  /**
   * Gửi vào thread theo tid (mọi kênh): Facebook, Zalo OA, Shopee… và TRẢ LỜI trên Zalo cá nhân
   * (reply_to_pid = pid tin được trả lời; zaloweb-messages không có trường trích dẫn).
   */
  async sendThreadMessage(
    pagePid: string,
    tid: string,
    body: { replyToPid?: string; messages: ThreadMessagePart[] },
  ): Promise<any> {
    const media = body.messages.some((m) => m.picture || m.video || m.file);
    return this.request(
      'POST',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/threads/${tid}/messages`,
      {
        ...(body.replyToPid ? { reply_to_pid: body.replyToPid } : {}),
        messages: body.messages,
      },
      // Smax tự tải media từ URL rồi đẩy lên nền tảng → lâu hơn tin chữ
      { timeout: media ? 60000 : 15000 },
    );
  }

  /** Trạng thái kết bạn giữa kênh và người dùng Zalo (uid). */
  /**
   * Avatar bạn bè của kênh theo pid ("zlw" + uid). Link ảnh Zalo có hạn: ảnh trong
   * tin / thread của Smax hay đã hết hạn, danh sách bạn bè thì mới. Danh sách lớn (~4MB).
   */
  async listFriendAvatars(pagePid: string): Promise<Record<string, string>> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/friends`,
      undefined,
      { timeout: 30_000 },
    );
    // Smax bọc danh sách trong data.data
    let rows: any = body;
    while (rows && !Array.isArray(rows)) rows = rows.data;
    const out: Record<string, string> = {};
    for (const r of rows ?? []) if (r?.userId && r?.avatar) out[`zlw${r.userId}`] = r.avatar;
    return out;
  }

  async getFriendStatus(pagePid: string, uid: string): Promise<SmaxFriendStatus | null> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/request-friend-status?uid=${encodeURIComponent(uid)}`,
      undefined,
      { allow404: true },
    );
    const result = body?.data?.decodedData ?? body?.data;
    if (!result || (result.error_code !== undefined && result.error_code !== 0)) return null;
    const d = result.data ?? result;
    return {
      isFriend: Number(d.is_friend) === 1,
      // is_requested: kênh đã gửi lời mời cho khách; is_requesting: khách đang mời kênh
      isRequested: Number(d.is_requested) === 1,
      isRequesting: Number(d.is_requesting) === 1,
    };
  }

  /** Gửi lời mời kết bạn (Partner API không có lệnh "đồng ý" riêng). */
  async requestFriend(pagePid: string, uid: string, message: string): Promise<any> {
    return this.request('POST', `/partner/bizs/${this.bizAlias}/pages/${pagePid}/request-friend`, {
      uid,
      message,
    });
  }

  /** Thu hồi lời mời kết bạn kênh đã gửi. */
  async undoRequestFriend(pagePid: string, uid: string): Promise<any> {
    return this.request('POST', `/partner/bizs/${this.bizAlias}/pages/${pagePid}/undo-request-friend`, {
      uid,
    });
  }

  /** Tra người dùng Zalo theo SĐT từ kênh Zalo cá nhân; null nếu không thấy. */
  async findFriendByPhone(
    pagePid: string,
    phone: string,
  ): Promise<{ uid: string; name: string } | null> {
    const body = await this.request(
      'GET',
      `/partner/bizs/${this.bizAlias}/pages/${pagePid}/friend?phone=${encodeURIComponent(phone)}`,
      undefined,
      { allow404: true },
    );
    // Smax bọc kết quả Zalo {error_code, error_message, data}:
    // - tìm thấy: body.data = {error_code: 0, data: {uid, display_name…}}
    // - lỗi: body.data.decodedData = {error_code: 216 "User không hợp lệ"
    //   (SĐT không có Zalo / ẩn tìm theo SĐT) | 219 "SĐT không hợp lệ", …}
    const result = body?.data?.decodedData ?? body?.data;
    if (result?.error_code !== undefined && result.error_code !== 0) return null;
    const f = result?.data ?? result;
    const uid = f?.uid ?? f?.userId ?? f?.id;
    if (!uid) return null;
    return {
      uid: String(uid),
      name: f.display_name ?? f.zalo_name ?? f.zaloName ?? f.name ?? '',
    };
  }

  private async get(path: string): Promise<any> {
    return this.request('GET', path);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: any,
    opts: {
      allow404?: boolean;
      timeout?: number;
      token?: string;
      silent?: boolean;
    } = {},
  ): Promise<any> {
    if (!opts.token && !this.token) {
      throw new ServiceUnavailableException(
        'Chưa cấu hình SMAX_API_TOKEN trong .env của backend',
      );
    }
    try {
      const res = await firstValueFrom(
        this.http.request({
          method,
          url: `${this.baseUrl}${path}`,
          data,
          headers: { Authorization: `Bearer ${opts.token ?? this.token}` },
          timeout: opts.timeout ?? 15000,
        }),
      );
      return res.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404 && opts.allow404) return null;
      if (!opts.silent) {
        this.logger.error(
          `Smax ${method} ${path} lỗi ${status ?? ''}: ${JSON.stringify(
            error?.response?.data ?? error?.message,
          )}`,
        );
      }
      // 400/422: Smax/nền tảng từ chối có lý do rõ (vd khách chặn tin từ người lạ, Facebook quá 24h) → báo đúng lý do
      const smaxMessage = error?.response?.data?.message;
      if ((status === 400 || status === 422) && typeof smaxMessage === 'string' && smaxMessage) {
        throw new BadRequestException(`${/\/pages\/zlw/.test(path) ? 'Zalo' : 'Smax'}: ${smaxMessage.trim()}`);
      }
      const reason =
        status === 401
          ? opts.token
            ? 'SMAX_USER_TOKEN hết hạn hoặc không hợp lệ — lấy token đăng nhập Smax mới'
            : 'token không hợp lệ hoặc đã hết hạn'
          : status === 403
            ? 'token không có quyền'
            : status === 429
              ? 'gọi API quá nhiều, thử lại sau'
              : 'không kết nối được';
      throw new BadGatewayException(`Smax: ${reason}`);
    }
  }
}

/** Tối đa 4 thành viên (tên + ảnh) của thread nhóm — ghép avatar nhóm kiểu Zalo. */
function memberPreview(t: any): { name: string | null; avatar: string | null }[] {
  return (t.customer_pids ?? [])
    .filter((p: string) => p !== 'zlw0' && p !== t.tid)
    .slice(0, 4)
    .map((p: string) => {
      const c = (t.customers ?? []).find((x: any) => x?.pid === p);
      return { name: c?.name ?? null, avatar: c?.picture ?? null };
    });
}
