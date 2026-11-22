import {
  isAckOnly,
  isCommunityGroup,
  isStaffName,
  looksUpset,
  workingMinutes,
} from './wait-alerts';

// Giờ VN → Date (UTC+7)
const vn = (s: string) => new Date(`${s}+07:00`);

describe('workingMinutes (T2–T6 8–18h, T7 8–12h, CN nghỉ)', () => {
  it('trong cùng ngày làm', () => {
    // 23/11/2026 là Thứ 2
    expect(
      workingMinutes(vn('2026-11-23T09:00:00'), vn('2026-11-23T09:45:00')),
    ).toBe(45);
  });
  it('ngoài giờ không tính: 17:50 → 8:25 hôm sau = 10 + 25', () => {
    expect(
      workingMinutes(vn('2026-11-23T17:50:00'), vn('2026-11-24T08:25:00')),
    ).toBe(35);
  });
  it('Thứ 7 chỉ tới 12:00, Chủ nhật nghỉ', () => {
    // 28/11 Thứ 7 11:30 → 30/11 Thứ 2 8:10 = 30 + 10
    expect(
      workingMinutes(vn('2026-11-28T11:30:00'), vn('2026-11-30T08:10:00')),
    ).toBe(40);
  });
  it('tin Chủ nhật tính từ 8:00 Thứ 2', () => {
    expect(
      workingMinutes(vn('2026-11-29T10:00:00'), vn('2026-11-30T08:20:00')),
    ).toBe(20);
    expect(
      workingMinutes(vn('2026-11-29T10:00:00'), vn('2026-11-29T20:00:00')),
    ).toBe(0);
  });
  it('đến trước đi → 0', () => {
    expect(
      workingMinutes(vn('2026-11-23T10:00:00'), vn('2026-11-23T09:00:00')),
    ).toBe(0);
  });
});

describe('looksUpset', () => {
  it.each([
    'chưa gửi hàng cho chị à',
    'Sao lâu vậy em',
    'bao giờ mới giao',
    'chị thất vọng quá',
    'giao chưa vậy??',
    'Hàng hư hết rồi',
  ])('"%s" → bực', (t) => expect(looksUpset(t)).toBe(true));
  it.each(['Dạ em cảm ơn', 'Lấy chị 2 thùng mứt xoài', 'ok em', ''])(
    '"%s" → bình thường',
    (t) => expect(looksUpset(t)).toBe(false),
  );
});

describe('isStaffName / isAckOnly', () => {
  it('nhân viên dùng Zalo cá nhân tên thương hiệu', () => {
    for (const n of [
      'Diệp Trà - Mr Sĩ Phú',
      'Diệp Trà  Kênh Bán Sỉ',
      'Kế Toán Diệp Trà',
      'Gấu LerMao - Ms Thư',
    ])
      expect(isStaffName(n)).toBe(true);
    for (const n of [
      'Bin Nguyen',
      'Trần Thị Hoa',
      'Hi Bún Chả (Ms Tuyền)',
      '',
      null,
    ])
      expect(isStaffName(n)).toBe(false);
  });
  it('tin chỉ để xác nhận không cần trả lời', () => {
    for (const t of [
      'Vâng',
      'Đúng r e ơi',
      'ok cảm ơn em nhiều',
      'Dạ',
      '👍',
      'oke nha',
    ])
      expect(isAckOnly(t)).toBe(true);
    for (const t of [
      'ok gửi chị giá nhé',
      'vs mình có loại nào nhân phomai?',
      'attach',
      'C gửi e giá nh',
    ])
      expect(isAckOnly(t)).toBe(false);
  });
});

it('nhóm cộng đồng không cảnh báo', () => {
  expect(isCommunityGroup('CỘNG ĐỒNG LERMAO BẾN TRE')).toBe(true);
  expect(isCommunityGroup('Cộng đồng khách hàng Lermao - Cafe Show 2026')).toBe(
    true,
  );
  expect(isCommunityGroup('Mr. Viễn - Phan Thiết, Bình Thuận - Diệp Trà')).toBe(
    false,
  );
});
