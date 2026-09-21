-- Run manually after backing up the target database.
-- Demand no longer uses an approval step. Existing DRAFT months must become
-- CONFIRMED so they are included in purchasing planning.

BEGIN;

SELECT COUNT(*) AS draft_months_before
FROM customer_demand_months
WHERE status = 'DRAFT';

UPDATE customer_demand_months
SET status = 'CONFIRMED'
WHERE status = 'DRAFT';

DELETE FROM user_branch_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE name = 'customer_demand:approve'
);

DELETE FROM role_branch_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE name = 'customer_demand:approve'
);

DELETE FROM user_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE name = 'customer_demand:approve'
);

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE name = 'customer_demand:approve'
);

DELETE FROM permissions
WHERE name = 'customer_demand:approve';

SELECT COUNT(*) AS draft_months_after
FROM customer_demand_months
WHERE status = 'DRAFT';

SELECT COUNT(*) AS approve_permissions_remaining
FROM permissions
WHERE name = 'customer_demand:approve';

COMMIT;
