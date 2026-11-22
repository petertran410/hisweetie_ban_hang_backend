import {
  buildDailyCard,
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

describe('buildDailyCard', () => {
  it('tiêu đề ngày, các mục có số lượng, mục rỗng ghi "Không có."', () => {
    const card = JSON.stringify(buildDailyCard(REPORT));
    expect(card).toContain('BÁO CÁO CHAT CUỐI NGÀY 22/11/2026');
    expect(card).toContain('Phàn nàn / khiếu nại (1)');
    expect(card).toContain('**chưa xử lý**');
    expect(card).toContain('Báo giá lệch cho cùng sản phẩm (0)');
    expect(card).toContain('Không có.');
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
