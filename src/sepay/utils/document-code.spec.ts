import { extractDocumentCodeCandidates } from './document-code';

describe('extractDocumentCodeCandidates', () => {
  it('không đọc ngày giao dịch dính sau mã thành hậu tố (nội dung QR ngân hàng)', () => {
    expect(
      extractDocumentCodeCandidates(
        'TKP#QRPSEP1ZZZZ54900790#6324PGBLP2FU8SPB.DH129766.20261120.112809.1313333797999.CTTNHH TM VA TP NGOC OANH.970430',
      ),
    ).toEqual(['DH129766']);
  });

  it('giữ hậu tố 2 chữ số của mã đã sửa, kèm mã gốc phía sau', () => {
    expect(extractDocumentCodeCandidates('TT HD049170.01 cam on')).toEqual([
      'HD049170.01',
      'HD049170',
    ]);
  });

  it('không phân biệt hoa thường', () => {
    expect(extractDocumentCodeCandidates('ck dh123456 cam on')).toEqual([
      'DH123456',
    ]);
  });

  it('trả về mọi mã theo thứ tự xuất hiện, không trùng', () => {
    expect(
      extractDocumentCodeCandidates('HD111111 va DH222222, lai HD111111'),
    ).toEqual(['HD111111', 'DH222222']);
  });

  it('trả về rỗng khi nội dung không có mã', () => {
    expect(extractDocumentCodeCandidates('20024')).toEqual([]);
    expect(extractDocumentCodeCandidates('')).toEqual([]);
  });
});
