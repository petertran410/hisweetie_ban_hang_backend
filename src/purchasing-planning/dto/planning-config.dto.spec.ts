import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanningConfigDto } from './planning-config.dto';

describe('CreatePlanningConfigDto', () => {
  it.each([
    [{ scopeType: 'GLOBAL', coverageDays: 0 }, 'coverageDays'],
    [{ scopeType: 'GLOBAL', growthFactor: -0.1 }, 'growthFactor'],
    [{ scopeType: 'GLOBAL', moq: 0 }, 'moq'],
  ])('rejects invalid numeric boundary %p', async (input, property) => {
    const errors = await validate(
      plainToInstance(CreatePlanningConfigDto, input),
    );
    expect(errors.map((error) => error.property)).toContain(property);
  });

  it('accepts zero growth and zero lead/safety days', async () => {
    const dto = plainToInstance(CreatePlanningConfigDto, {
      scopeType: 'GLOBAL',
      leadTimeDays: 0,
      safetyDays: 0,
      coverageDays: 1,
      growthFactor: 0,
      moq: 1,
    });
    expect(await validate(dto)).toEqual([]);
  });
});
