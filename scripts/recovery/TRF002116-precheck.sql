-- ===========================================================================
-- TRF002116 PRE-CHECK (read-only)
-- Mục đích: snapshot trạng thái trước khi recovery để verify và làm bằng chứng
-- Chạy: psql ... -f TRF002116-precheck.sql
-- ===========================================================================

\echo '=== 1. Header phiếu chuyển ==='
SELECT id, code, status,
       "fromBranchId", "fromBranchName",
       "toBranchId",   "toBranchName",
       "transferredDate", "receivedDate",
       "totalTransfer", "totalReceive",
       "createdAt", "updatedAt"
FROM transfers
WHERE code = 'TRF002116';

\echo ''
\echo '=== 2. Chi tiết 23 dòng sản phẩm ==='
SELECT id, "productId", "productCode",
       "sendQuantity", "receivedQuantity",
       "sendPrice", "receivePrice",
       "totalTransfer", "totalReceive"
FROM transfer_details
WHERE "transferId" = (SELECT id FROM transfers WHERE code = 'TRF002116')
ORDER BY id;

\echo ''
\echo '=== 3. Tồn kho hiện tại ở chi nhánh nhận (Kho Sài Gòn) ==='
SELECT inv."productId", inv."productCode",
       inv."onHand", inv.cost
FROM inventories inv
WHERE inv."branchId" = (
        SELECT "toBranchId" FROM transfers WHERE code = 'TRF002116'
      )
  AND inv."productId" IN (
        SELECT "productId" FROM transfer_details
        WHERE "transferId" = (SELECT id FROM transfers WHERE code = 'TRF002116')
      )
ORDER BY inv."productId";

\echo ''
\echo '=== 4. Inventory logs liên quan tới phiếu này ==='
SELECT id, "productCode", "branchId", "branchName",
       "transactionType", quantity, "createdAt"
FROM inventory_logs
WHERE "refCode" = 'TRF002116'
ORDER BY "createdAt", id;

\echo ''
\echo '=== 5. Audit logs liên quan ==='
SELECT id, action_code, action_type, user_id, user_name, created_at
FROM audit_logs
WHERE entity_code = 'TRF002116'
ORDER BY created_at;
