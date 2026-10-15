import { approvalHistory, endingStep } from './approval-history';

describe('approvalHistory', () => {
  // Timeline thật của tuần W40 Kho HN.
  const snapshot = {
    timeline: [
      { type: 'START', create_time: '1791457222000', open_id: 'ou_a' },
      {
        type: 'PASS',
        create_time: '1791521344000',
        open_id: 'ou_b',
        comment: 'kt kho đã kiểm tra đầy đủ chứng từ',
      },
      {
        type: 'REJECT',
        create_time: '1791711701000',
        user_id: 'ou_c',
        comment: ' bị trùng với phiếu tuần 37 đã tính CP ',
      },
    ],
  };

  it('reads type, time, comment and the actor open_id', () => {
    const history = approvalHistory(snapshot);
    expect(history.map((item) => item.type)).toEqual([
      'START',
      'PASS',
      'REJECT',
    ]);
    expect(history[0]).toEqual({
      type: 'START',
      time: new Date(1791457222000).toISOString(),
      comment: null,
      openId: 'ou_a',
    });
    expect(history[2].openId).toBe('ou_c');
  });

  it('finds the step that ended the approval, with a trimmed comment', () => {
    expect(endingStep(approvalHistory(snapshot))).toMatchObject({
      type: 'REJECT',
      comment: 'bị trùng với phiếu tuần 37 đã tính CP',
    });
  });

  it('copes with a missing or malformed snapshot', () => {
    expect(approvalHistory(null)).toEqual([]);
    expect(approvalHistory({ timeline: 'x' })).toEqual([]);
    expect(endingStep([])).toBeNull();
  });
});
