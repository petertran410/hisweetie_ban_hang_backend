import {
  buildDailyCard,
  channelLabel,
  dailyReportUrl,
  DailyReportService,
  findDiscrepancies,
  type DailyReport,
} from './daily-report.service';

const PRODUCTS = [
  {
    id: 1,
    code: 'MBL',
    name: 'Gấu Lermao - Matcha Bạch Lan 500gr',
    unit: 'Gói',
  },
  { id: 2, code: 'TL', name: 'Trà lài Phượng Hoàng 500gr', unit: 'Gói' },
];

describe('findDiscrepancies', () => {
  it('giá viết tắt nghìn đồng ("330") quy về đồng; chênh < 5% không tính là lệch', () => {
    const result = findDiscrepancies(
      [
        { product: 'matcha bạch lan', price: 330, customer: 'A', channel: 'K' },
        {
          product: 'matcha bạch lan',
          price: 330000,
          customer: 'B',
          channel: 'K',
        },
        { product: 'trà lài', price: 115000, customer: 'C', channel: 'K' },
        { product: 'trà lài', price: 118000, customer: 'D', channel: 'K' },
      ],
      PRODUCTS,
    );
    expect(result).toEqual([]);
  });

  it('cùng sản phẩm, ≥ 2 mức giá → lệch; một mức giá → không', () => {
    const result = findDiscrepancies(
      [
        {
          product: 'matcha bạch lan',
          price: 330000,
          customer: 'Ms Hải Triều',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'Matcha Bạch Lan 500gr',
          price: 400000,
          customer: 'Lê Duy Minh',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'trà lài',
          price: 115000,
          customer: 'Mr Viễn',
          channel: 'Ms Mai Phương',
        },
        {
          product: 'trà lài',
          price: 115000,
          customer: 'Chị Huệ',
          channel: 'Diệp Trà Cs',
        },
      ],
      PRODUCTS,
    );
    expect(result).toEqual([
      {
        product: 'Gấu Lermao - Matcha Bạch Lan 500gr',
        prices: [
          { price: 330000, customer: 'Ms Hải Triều', channel: 'Ms Mai Phương' },
          { price: 400000, customer: 'Lê Duy Minh', channel: 'Ms Mai Phương' },
        ],
      },
    ]);
  });
});

const REPORT: DailyReport = {
  day: '2026-11-22',
  stats: { channels: 7, threads: 86, messages: 900 },
  complaints: [
    {
      customer: 'Mr Nhật Anh',
      channel: 'Ms Mai Phương',
      issue: 'Trái cây có sâu',
      handled: false,
    },
  ],
  pending: [
    {
      customer: 'Tiệm bánh Hazen',
      channel: 'Ms Mai Phương',
      request: 'Chưa nhận được hàng',
      since: '09:10',
    },
  ],
  discrepancies: [],
  model: 'm',
  tokens: 1,
};

describe('dailyReportUrl', () => {
  it('chỉ gắn link khi địa chỉ POS là https', () => {
    expect(dailyReportUrl('2026-11-23', 'https://pos.example/')).toBe('https://pos.example/bao-cao/smax?tab=cuoi-ngay&ngay=2026-11-23');
    expect(dailyReportUrl('2026-11-23', 'http://localhost:3050')).toBeNull();
    expect(dailyReportUrl('2026-11-23', '')).toBeNull();
  });
  it('card: "Còn N mục khác" trỏ link POS', () => {
    const pending = Array.from({ length: 12 }, () => REPORT.pending[0]);
    const card = JSON.stringify(buildDailyCard({ ...REPORT, pending }, 'https://pos.example/x'));
    expect(card).toContain('[xem danh sách đầy đủ trên POS](https://pos.example/x)');
  });
});

describe('channelLabel', () => {
  it('loại kênh + tên kênh', () => {
    expect(channelLabel({ platform: 'facebook', name: 'LerMao - Sành Ăn Như Gấu' })).toBe('Facebook · LerMao - Sành Ăn Như Gấu');
    expect(channelLabel({ platform: 'zaloweb', name: 'Diệp Trà - Ms Mai Phương' })).toBe('Zalo cá nhân · Diệp Trà - Ms Mai Phương');
    expect(channelLabel({ platform: 'tiktokweb', name: 'Gấu LerMao' })).toBe('TikTok · Gấu LerMao');
    expect(channelLabel({ platform: 'shopee', name: 'LerMao Official' })).toBe('Shopee · LerMao Official');
  });
});

describe('buildDailyCard', () => {
  const texts = (card: any): string[] => card.body.elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content);

  it('card JSON 2.0 theo mẫu: tiêu đề + ngày, tổng quan, 3 mục ưu tiên, việc cần làm', () => {
    const card: any = buildDailyCard(REPORT);
    expect(card.schema).toBe('2.0');
    expect(card.header.title.content).toBe('📊 BÁO CÁO CHAT CUỐI NGÀY');
    expect(card.header.subtitle.content).toBe('22/11/2026 · Báo cáo tự động');
    const all = texts(card).join('\n');
    expect(all).toContain('**86** hội thoại  ·  **900** tin nhắn');
    expect(all).toContain('### 🔴 ƯU TIÊN 1 · KHIẾU NẠI CHƯA XỬ LÝ (1)');
    expect(all).toContain('<font color="grey">(Ms Mai Phương)</font> — Trái cây có sâu.');
    expect(all).toContain('**Tiệm bánh Hazen** <font color="grey">(Ms Mai Phương)</font> · **09:10** — Chưa nhận được hàng.');
    expect(all).toContain('### 💰 ƯU TIÊN 3 · CẢNH BÁO GIÁ (0)\nKhông có.');
    // Không có cảnh báo giá → bỏ việc "Đối chiếu", đánh số liền
    const todo = texts(card).find((t) => t.startsWith('### ✅ VIỆC CẦN LÀM'))!;
    expect(todo).toContain('2. Phân loại 1 mục');
    expect(todo).toContain('3. Loại tin xác nhận đơn giản');
    expect(todo).not.toContain('Đối chiếu');
  });

  it('nhiều mục: 10 dòng mới nhất trước + "Còn N mục khác"', () => {
    const pending = Array.from({ length: 13 }, (_, i) => ({
      ...REPORT.pending[0],
      request: `Yêu cầu ${i}`,
      since: `${String(8 + i).padStart(2, '0')}:00`,
    }));
    const section = texts(buildDailyCard({ ...REPORT, pending })).find((t) => t.includes('ƯU TIÊN 2'))!;
    const lines = section.split('\n');
    expect(lines[1]).toContain('· **20:00**');
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.at(-1)).toBe('_Còn 3 mục khác — xem danh sách đầy đủ trên POS (Báo cáo › Smax chat › Báo cáo chat cuối ngày)._');
  });
});

describe('DailyReportService.send', () => {
  it('đã gửi trong ngày (có audit) → không gửi lại', async () => {
    const create = jest.fn();
    const service = new DailyReportService(
      { auditLog: { count: jest.fn().mockResolvedValue(1) } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { im: { message: { create } } } as any,
    );
    await expect(service.send('2026-11-22')).resolves.toEqual({
      sent: false,
      reason: 'already_sent',
    });
    expect(create).not.toHaveBeenCalled();
  });
});
