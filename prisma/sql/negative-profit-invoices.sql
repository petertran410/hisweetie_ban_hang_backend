-- Hóa đơn có lợi nhuận âm (profit < 0)
-- profit = grandTotal - COGS
-- COGS   = SUM(invoice_details.quantity * inventories.cost)  (join theo productId + branchId)
-- Tham số: :from_date, :to_date (khoảng [from, to))
SELECT
  i.id,
  i.code,
  i."purchaseDate",
  u.name  AS sold_by,
  c.name  AS customer,
  b.name  AS branch,
  i."grandTotal"::float8                              AS revenue,
  COALESCE(li.cogs, 0)::float8                         AS cost,
  (i."grandTotal" - COALESCE(li.cogs, 0))::float8      AS profit
FROM invoices i
LEFT JOIN LATERAL (
  SELECT SUM(d.quantity * COALESCE(inv.cost, 0)) AS cogs
  FROM invoice_details d
  LEFT JOIN inventories inv
    ON inv."productId" = d."productId" AND inv."branchId" = i."branchId"
  WHERE d."invoiceId" = i.id
) li ON true
LEFT JOIN users u     ON u.id = i."soldById"
LEFT JOIN customers c ON c.id = i."customerId"
LEFT JOIN branches b  ON b.id = i."branchId"
WHERE i."purchaseDate" >= :from_date
  AND i."purchaseDate" <  :to_date
  AND (i."grandTotal" - COALESCE(li.cogs, 0)) < 0
ORDER BY profit ASC;
