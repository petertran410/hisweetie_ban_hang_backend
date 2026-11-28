import { BURST_SETTLE_MS, type BurstRow, findBurst } from './burst';

const at = (hms: string) => new Date(`2026-11-28T${hms}+07:00`);
let seq = 0;
const kh = (hms: string, text: string): BurstRow => ({
  msgPid: `m${++seq}`,
  senderPid: 'zlwKH',
  createdAt: at(hms),
  text,
  member: true,
});
const nv = (hms: string, text: string): BurstRow => ({
  msgPid: `m${++seq}`,
  senderPid: 'zlwNV',
  createdAt: at(hms),
  text,
  member: false,
});

// Hội thoại Quỳnh Anh – kênh Bùi Hảo 28/11 (10:57–11:04), nội dung rút gọn
const thread = [
  { ...kh('10:57:31', 'Bạn vừa kết bạn với Quỳnh Anh'), member: false },
  nv('10:57:37', 'C ơi'),
  kh('10:57:41', 'Dạ e nghe ạ'),
  nv('10:58:18', 'Gọi lai công hòa…'),
  kh('10:59:12', 'Nó bịp đấy'),
  kh('10:59:17', 'C cứ gửi công hoà đi'),
  kh('10:59:23', 'Hư hàng e chịu cho'),
  kh('10:59:26', 'C k phải lo đâu'),
  nv('10:59:30', '😅😅'),
  kh('10:59:38', 'Bữa nó cũng kêu bọn c k về'),
  kh('10:59:44', 'Nhưng xong nó trả hàng cho e đấy'),
  nv('10:59:48', 'Để e bảo kho ạ.'),
  kh('11:00:38', 'Thế c bỏ giúp e 2t an phú quý'),
  kh('11:00:44', '3t công hoà được k?'),
  nv('11:01:57', 'như thế bị tách đơn cước cao k ạ.'),
  kh('11:02:19', '2t khoai nghiền ném an phú quý giúp e là đc'),
  kh('11:02:22', 'Còn 3t bỏ công hoà'),
  kh('11:02:31', 'Thà 2 thùng chịu cước cao còn hơn là 5t chị ạ'),
  kh('11:02:32', ':)))'),
  kh('11:02:47', 'Chứ 1 xốp kia e về có 25k cả tiền xích lô ý'),
  kh('11:02:50', 'An phú quý 100k'),
  kh('11:02:55', 'Xót lắm'),
  kh('11:02:56', ''), // sticker
  kh('11:03:02', 'Mà thôi kệ đi'),
  kh('11:03:06', 'Cho về công hoà cả đi'),
  kh('11:03:09', 'Mai e đòi cho'),
  nv('11:03:44', 'Dạ vâng…'),
  kh('11:04:41', 'Ukila'),
];
const later = at('11:30:00');

describe('findBurst', () => {
  it('hội thoại Quỳnh Anh: 20 tin khách → 6 cụm, mỗi tin trong cụm ra cùng 1 tin cuối', () => {
    const heads = new Map<string, number>();
    for (const r of thread.filter((x) => x.member)) {
      const b = findBurst(thread, r.msgPid, later)!;
      expect(b.complete).toBe(true);
      const head = b.members[b.members.length - 1].msgPid;
      heads.set(head, b.members.length);
    }
    expect([...heads.values()]).toEqual([1, 4, 2, 2, 11, 1]);
  });

  it('tin nhân viên / thông báo không gộp (cụm 1 tin), và cắt cụm của khách', () => {
    const notice = findBurst(thread, thread[0].msgPid, later)!;
    expect(notice.members).toHaveLength(1);
    const staff = findBurst(thread, thread[1].msgPid, later)!;
    expect(staff.members.map((m) => m.text)).toEqual(['C ơi']);
  });

  it('tin cách tin trước > 2 phút hoặc người gửi khác → cụm mới', () => {
    const rows = [
      kh('09:00:00', 'a'),
      kh('09:02:01', 'b'), // cách 121 giây
      { ...kh('09:02:10', 'c'), senderPid: 'zlwKHACKHAC' },
    ];
    expect(findBurst(rows, rows[0].msgPid, later)!.members).toHaveLength(1);
    expect(findBurst(rows, rows[1].msgPid, later)!.members).toHaveLength(1);
  });

  it('giới hạn 20 tin / 1.500 ký tự / 10 phút: chia từ đầu chuỗi, xét từ tin nào cũng ra cùng cụm', () => {
    const rows = Array.from({ length: 23 }, (_, i) =>
      kh(`09:00:${String(i * 2).padStart(2, '0')}`, 'x'),
    );
    const first = findBurst(rows, rows[5].msgPid, later)!;
    expect(first.members).toHaveLength(20);
    expect(first.members[0].msgPid).toBe(rows[0].msgPid);
    expect(findBurst(rows, rows[21].msgPid, later)!.members).toHaveLength(3);
    const long = [
      kh('09:00:00', 'a'.repeat(1000)),
      kh('09:00:05', 'b'.repeat(600)),
    ];
    expect(findBurst(long, long[1].msgPid, later)!.members).toHaveLength(1);
    const slow = Array.from({ length: 7 }, (_, i) =>
      kh(`09:${String(i * 2).padStart(2, '0')}:00`, 'y'),
    ); // mỗi tin cách 2 phút, kéo dài 12 phút
    expect(findBurst(slow, slow[6].msgPid, later)!.members).toHaveLength(1);
    expect(findBurst(slow, slow[0].msgPid, later)!.members).toHaveLength(6);
  });

  it('cụm chưa xong khi tin cuối còn mới và chưa có tin sau; có tin sau cắt cụm hoặc đủ lâu → xong', () => {
    const rows = [kh('09:00:00', 'a'), kh('09:00:30', 'b')];
    const soon = new Date(at('09:00:30').getTime() + BURST_SETTLE_MS - 1000);
    expect(findBurst(rows, rows[0].msgPid, soon)!.complete).toBe(false);
    const done = new Date(at('09:00:30').getTime() + BURST_SETTLE_MS);
    expect(findBurst(rows, rows[0].msgPid, done)!.complete).toBe(true);
    const replied = [...rows, nv('09:00:40', 'dạ')];
    expect(findBurst(replied, rows[0].msgPid, soon)!.complete).toBe(true);
  });
});
