import {
  nppTicketPath,
  resolveRecipients,
  testModeNote,
} from './new-product-price-notify.service';

describe('nppTicketPath', () => {
  it('link xem phiếu: chỉ có Code', () => {
    expect(nppTicketPath('SPM000001')).toBe(
      '/san-pham/bang-gia-san-pham-moi?Code=SPM000001',
    );
  });

  it('tin cần xử lý: thêm open=1 để mở sẵn modal', () => {
    expect(nppTicketPath('SPM000001', true)).toBe(
      '/san-pham/bang-gia-san-pham-moi?Code=SPM000001&open=1',
    );
  });
});
import { buildTicketCard } from './new-product-price-lark-cards';

describe('resolveRecipients', () => {
  it('gửi thật: bỏ trùng và bỏ người đang thao tác', () => {
    expect(resolveRecipients([20, 21, 20, 10], 10, [])).toEqual({
      intended: [20, 21],
      sendTo: [20, 21],
      testMode: false,
    });
  });

  it('gửi thử: CHỈ gửi tới danh sách gửi thử, kể cả khi đó là người thao tác', () => {
    expect(resolveRecipients([20, 21], 1, [1])).toEqual({
      intended: [20, 21],
      sendTo: [1],
      testMode: true,
    });
  });

  it('gửi thử vẫn gửi khi chưa cấu hình người nhận thật', () => {
    const r = resolveRecipients([], 1, [1]);
    expect(r.sendTo).toEqual([1]);
    expect(r.intended).toEqual([]);
  });
});

describe('ghi chú gửi thử trên card', () => {
  it('nêu người nhận thật ở đầu tin và trong thông báo app', () => {
    const built = buildTicketCard(
      'ENTER_CEO',
      { code: 'SPM000001', productName: 'Siro', createdAt: new Date() },
      { link: 'https://pos/x', testNote: testModeNote(['Chị A', 'Anh B']) },
    );
    const content = (built.card as any).elements[0].text.content as string;
    expect(
      content.startsWith('🧪 **GỬI THỬ** — người nhận thật: Chị A, Anh B'),
    ).toBe(true);
    expect(built.body.startsWith('[Gửi thử] SPM000001')).toBe(true);
    expect(testModeNote([])).toContain('(chưa cấu hình người nhận)');
  });
});
