# Internal Fund

## Ownership

POS owns internal receipts, warehouse/office expenses, transfers and daily
closings. Lark Approval remains the approval provider. No new finance records
are written to Lark Base; the historical importers remain available.

Warehouse customer receipts retain their existing CashFlow, invoice allocation
and customer debt behavior. The internal fund services never import or invoke
CashFlowsService. Older approvals cannot be linked or posted to CashFlow through
the legacy approval endpoints.

## Activation

The schema adds `internal_fund_transactions`, `internal_fund_transfers` and
`internal_fund_daily_closings`, including unique source keys and the optional
expense entry link. Prisma Client generation alone does not create these tables.

1. Have the database operator review and synchronize the schema.
2. Review `scripts/add-internal-fund-permissions.sql`, then have the operator
   execute it. It adds permission definitions only, not role/user assignments.
3. Assign permissions in the existing role/user UI and refresh the login session.
4. Restart the API after schema synchronization.
5. Before production cutover, disable the tenant's old Approval-to-Base sync and
   Base automations separately. POS does not control those external settings;
   keeping them enabled could still produce Base records outside POS.

No database push, migration, reset or seed is run by this implementation.
Existing CashFlow data is not migrated, cancelled or rewritten.

## Permissions

Scopes: HN = branch 6, SG = branch 1, VP = branches 4 and 7.
Backend permission checks resolve the effective permissions for the actual data
branch, not the browser's selected header branch.

Receipt creation requires `create_receipt` and `submit_approval`. A transfer
also requires `transfer` permission for both branches. Cancellation of a
transfer requires `cancel` for both branches. `adjust` is required in addition
to the normal action when a date or a subsequent date has already been closed.

Existing `warehouse_expense` permissions remain valid. The expense screens and
services also accept the corresponding `internal_fund` permissions.

## APIs

- `GET /internal-fund/access`
- `GET /internal-fund/transactions`
- `POST /internal-fund/transactions`: submit a receipt Approval
- `PATCH /internal-fund/transactions/:id`: reasoned description correction
- `PUT /internal-fund/transactions/:id/cancel`
- `POST /internal-fund/entries/:id/post`: expense issuance
- `POST /internal-fund/transactions/:id/post`: idempotent acknowledgement of a posted ledger transaction
- `GET /internal-fund/approvals`
- `POST /internal-fund/approvals/receipts`
- `POST /approval-requests`: domain receipt/transfer payload, not raw Lark widgets
- `POST /internal-fund/approvals/:id/post`: authorized recovery for approved requests
- `GET /internal-fund/transfers`
- `POST /internal-fund/transfers`
- `PUT /internal-fund/transfers/:id/cancel`
- `GET /internal-fund/summary`
- `GET /internal-fund/daily-closings`
- `POST /internal-fund/daily-closings`
- `POST /internal-fund/upload-file`: Approval attachment upload

Receipt/transfer submission accepts a stable `clientUuid`, `branchId`, `amount`,
`occurredAt`, `description`, `classification` (`OTHER`, `REFUND_ADVANCE` or
`INTERNAL_TRANSFER`), optional `destinationBranchId`, optional `payerOpenId`,
optional `tempAdvance`, and `attachmentCodes`. The server constructs all Lark
widget and option IDs. Upload accepts `branchId` and `file`.

This is a cash fund. Non-cash receipt methods are rejected and do not increase
the fund. Expense source records are reviewed and grouped using the existing
warehouse expense batch APIs; offices cannot receive packing/fuel/car-care
sources.

## Posting and Closing

- Approved weekly expenses are not automatically posted. Explicit issuance
  creates one fund expense, linked by unique entry ID/source key.
- Approved internal receipts are posted by the Approval callback/reconciler.
- Approved transfers create both legs in the same status-update transaction.
- A replay cannot recreate cancelled transactions or a cancelled transfer.
- Posting, cancelling and closing serialize using sorted per-branch PostgreSQL
  advisory transaction locks. Unique source keys provide an additional guard.
- Days use Vietnam midnight, not UTC midnight.
- Opening balance sums all earlier active fund transactions, including dates
  without a closing. A new empty fund starts at zero; historical balances are
  not inferred from CashFlow or automatically imported.
- A closing stores the system and actual values, included transaction IDs,
  actor, time and an append-only snapshot history. Changing a closed date
  requires `adjust` and flags affected closings as `PENDING`; captured numbers
  are not silently rewritten.
- Late Approval receipts/transfers are recorded as approved and flag existing
  closings as `PENDING` for reconciliation.
- Approved amounts/dates are immutable. To correct them, cancel with a reason
  and submit a new Approval; only descriptions have a direct correction API.

## Local Verification

Unit tests use in-memory Prisma/Lark doubles, not a real DB or Approval instance.
The Nest module wiring test compiles without initializing scheduled tasks or
connecting to a database. Build/typecheck proves code compatibility, not
schema availability or live template/permission configuration.

Do not submit real Lark approvals while testing localhost against a production
Approval tenant. Runtime verification requires operator-created test fixtures
and explicitly approved integration settings.
