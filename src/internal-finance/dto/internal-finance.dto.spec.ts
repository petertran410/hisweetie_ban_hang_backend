import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InternalFinanceQueryDto } from './internal-finance.dto';

describe('InternalFinanceQueryDto', () => {
  it.each([
    ['6', [6]],
    [['6', '1'], [6, 1]],
    ['6,1', [6, 1]],
  ])('normalizes branchIds=%j into an integer array', async (input, expected) => {
    const dto = plainToInstance(InternalFinanceQueryDto, {
      branchIds: input,
    });
    const errors = await validate(dto);

    expect(dto.branchIds).toEqual(expected);
    expect(errors).toHaveLength(0);
  });
});
