import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePlanningConfigDto } from './planning-config.dto';

describe('CreatePlanningConfigDto', () => {
  it.each([
    [{ scopeType: 'GLOBAL', coverageDays: 0 }, 'coverageDays'],
    [{ scopeType: 'GLOBAL', safetyDays: -1 }, 'safetyDays'],
  ])('rejects invalid numeric boundary %p', async (input, property) => {
    const errors = await validate(
      plainToInstance(CreatePlanningConfigDto, input),
    );
    expect(errors.map((error) => error.property)).toContain(property);
  });

  it('accepts zero safety days', async () => {
    const dto = plainToInstance(CreatePlanningConfigDto, {
      scopeType: 'GLOBAL',
      safetyDays: 0,
      coverageDays: 1,
    });
    expect(await validate(dto)).toEqual([]);
  });
});
