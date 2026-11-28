import { type ArchiveRow, decide, groupByMsgPid } from './rule-engine';

const OURS = new Set(['zlwOUR1', 'zlwOUR2']);
let nextId = 1n;
const row = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  id: nextId++,
  pagePid: 'zlwOUR1',
  tid: 'zlw900001',
  msgPid: 'm1',
  senderPid: 'zlw555',
  senderName: 'Chị Lan',
  fromMe: false,
  type: 'message',
  text: 'Cho chị 2 thùng trà xanh nhé',
  attachments: null,
  sticker: null,
  recalled: false,
  createdAt: new Date('2026-11-27T03:00:00Z'),
  ...over,
});
const one = (over: Partial<ArchiveRow> = {}) =>
  decide(groupByMsgPid([row(over)])[0], OURS);

describe('groupByMsgPid', () => {
  it('gộp các dòng cùng msg_pid ở nhiều kênh, dòng đại diện là id nhỏ nhất, bỏ tin hệ thống', () => {
    const a = row({ id: 30n, pagePid: 'zlwOUR2', msgPid: 'x' });
    const b = row({ id: 10n, pagePid: 'zlwOUR1', msgPid: 'x' });
    const sys = row({ id: 5n, msgPid: 's', type: 'system' });
    const out = groupByMsgPid([a, sys, b]);
    expect(out).toHaveLength(1);
    expect(out[0].rep.id).toBe(10n);
    expect(out[0].rows).toHaveLength(2);
  });
});

describe('decide', () => {
  it('tin khách có nội dung → chờ Jev', () => {
    expect(one()).toEqual({ status: 'pending' });
  });

  it('tin nhân viên gửi từ kênh khác (from_me ở dòng của kênh đó) → bỏ qua dù dòng này from_me=false', () => {
    const msg = groupByMsgPid([
      row({ msgPid: 'k', pagePid: 'zlwOUR1', fromMe: false }),
      row({ msgPid: 'k', pagePid: 'zlwOUR2', fromMe: true }),
    ])[0];
    expect(decide(msg, OURS)).toEqual({
      status: 'skipped',
      skipReason: 'staff',
    });
  });

  it('người gửi là pid kênh công ty hoặc Zalo cá nhân tên thương hiệu → nhân viên', () => {
    expect(one({ senderPid: 'zlwOUR2' })).toEqual({
      status: 'skipped',
      skipReason: 'staff',
    });
    expect(one({ senderName: 'Diệp Trà - Ms Nhã Sale Admin' })).toEqual({
      status: 'skipped',
      skipReason: 'staff',
    });
    expect(one({ senderName: 'Kế Toán Diệp Trà' })).toEqual({
      status: 'skipped',
      skipReason: 'staff',
    });
  });

  it('tin báo đơn tự động → bỏ qua', () => {
    expect(
      one({
        text: '🎉 Báo đơn BD022155 - Giao hàng thành công\n🧾 Hoá đơn: HD138502',
      }),
    ).toEqual({
      status: 'skipped',
      skipReason: 'order_report',
    });
  });

  it('tin thu hồi ở bất kỳ kênh nào → bỏ qua', () => {
    const msg = groupByMsgPid([
      row({ msgPid: 'r' }),
      row({ msgPid: 'r', pagePid: 'zlwOUR2', recalled: true }),
    ])[0];
    expect(decide(msg, OURS)).toEqual({
      status: 'skipped',
      skipReason: 'recalled',
    });
  });

  it('không có chữ: chỉ ảnh → media_only, chỉ sticker → sticker_only (chưa hiểu, không phải âm tính)', () => {
    expect(
      one({ text: '', attachments: [{ type: 'image', url: 'u' }] }),
    ).toEqual({
      status: 'skipped',
      skipReason: 'media_only',
    });
    expect(one({ text: '  ', sticker: '12345' })).toEqual({
      status: 'skipped',
      skipReason: 'sticker_only',
    });
  });

  it('chỉ xác nhận ("Dạ", "ok cảm ơn em") → gắn nhãn bằng luật, không gọi Jev', () => {
    for (const text of ['Dạ', 'ok cảm ơn em', 'Vâng ạ', '👍']) {
      const d = one({ text });
      expect(d.status).toBe('completed');
      if (d.status === 'completed')
        expect(d.labels.intent).toBe('acknowledgment');
    }
  });

  it('xác nhận kèm nội dung khác vẫn đi Jev (vd khiếu nại thiếu hàng)', () => {
    expect(one({ text: 'Ok, nhưng hàng lần này vẫn bị thiếu' })).toEqual({
      status: 'pending',
    });
    expect(one({ text: 'ok mai giao nhé' })).toEqual({ status: 'pending' });
    expect(one({ text: 'dạ sao chưa giao ạ?' })).toEqual({ status: 'pending' });
  });

  it('"em gửi ạ" kèm ảnh không coi là chỉ xác nhận', () => {
    expect(
      one({ text: 'Dạ', attachments: [{ type: 'image', url: 'u' }] }),
    ).toEqual({ status: 'pending' });
  });

  it('thông báo Zalo (kết bạn, cuộc gọi đến / đi / video / nhỡ) → bỏ qua; câu nhắc tới cuộc gọi vẫn đi Jev', () => {
    for (const text of [
      'Bạn vừa kết bạn với Quỳnh Anh',
      'Cuộc gọi thoại đến \n📞<- 25 giây',
      'Cuộc gọi thoại đi\n📞-> 1 phút 3 giây',
      'Cuộc gọi video đi \n📞-> 9 giây',
      'Cuộc gọi nhỡ',
      'Cuộc gọi',
    ])
      expect(one({ text })).toEqual({
        status: 'skipped',
        skipReason: 'system_notice',
      });
    expect(
      one({ text: 'Cuộc gọi lúc nãy chị không nghe được, gọi lại giúp chị' }),
    ).toEqual({ status: 'pending' });
  });
});
