import {
  buildJevQuestions,
  FLAGS,
  INTENTS,
  PURCHASE_INTENT_LEVELS,
  TOPIC_PREFIX,
  TOPICS,
  URGENCY_LEVELS,
} from './taxonomy-v1';

describe('buildJevQuestions', () => {
  const questions = buildJevQuestions();

  it('đúng định dạng Jev: choice có criteria object (≤255), score là mảng 1–10 mức, noul cho topic / cờ', () => {
    expect(questions.intent).toMatchObject({ type: 'choice' });
    expect(
      Object.keys((questions.intent as { criteria: object }).criteria),
    ).toEqual(Object.keys(INTENTS));
    expect(Object.keys(INTENTS).length).toBeLessThanOrEqual(255);
    expect(questions.urgency).toMatchObject({
      type: 'score',
      criteria: [...URGENCY_LEVELS],
    });
    expect(questions.purchase_intent).toMatchObject({
      type: 'score',
      criteria: [...PURCHASE_INTENT_LEVELS],
    });
    for (const key of Object.keys(TOPICS))
      expect(questions[`${TOPIC_PREFIX}${key}`]).toMatchObject({
        type: 'noul',
      });
    for (const key of Object.keys(FLAGS))
      expect(questions[key]).toMatchObject({ type: 'noul' });
    expect(Object.keys(questions)).toHaveLength(
      4 + Object.keys(TOPICS).length + Object.keys(FLAGS).length,
    );
  });

  it('lựa chọn "khác" / "không đủ thông tin" nằm cuối (Jev hơi thiên về lựa chọn đầu)', () => {
    expect(Object.keys(INTENTS).slice(-2)).toEqual(['other', 'unclear']);
  });
});
