import { IsIn } from 'class-validator';
import type { LarkCustomerNotifyKind } from '../../lark-sync/services/lark-customer-notification.service';

export class TestLarkNotifyDto {
  @IsIn(['taxCode', 'newCustomerTask'])
  kind: LarkCustomerNotifyKind;
}
