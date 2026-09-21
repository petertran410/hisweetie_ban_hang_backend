-- Run manually on PostgreSQL before syncing duplicate products.
-- Drops only unique indexes whose indexed columns are exactly
-- (demand_month_id, product_id), regardless of generated index name.
DO $$
DECLARE
  unique_index RECORD;
  constraint_name TEXT;
BEGIN
  FOR unique_index IN
    SELECT i.indexrelid
    FROM pg_index AS i
    WHERE i.indrelid = 'customer_demand_lines'::regclass
      AND i.indisunique
      AND NOT i.indisprimary
      AND i.indnkeyatts = 2
      AND (
        SELECT array_agg(a.attname ORDER BY a.attname)
        FROM unnest(i.indkey) AS indexed_column(attnum)
        JOIN pg_attribute AS a
          ON a.attrelid = i.indrelid AND a.attnum = indexed_column.attnum
      ) = ARRAY['demand_month_id', 'product_id']
  LOOP
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conindid = unique_index.indexrelid;

    IF constraint_name IS NOT NULL THEN
      EXECUTE format(
        'ALTER TABLE customer_demand_lines DROP CONSTRAINT %I',
        constraint_name
      );
    ELSE
      EXECUTE format('DROP INDEX %s', unique_index.indexrelid::regclass);
    END IF;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS customer_demand_lines_demand_month_id_product_id_idx
  ON customer_demand_lines (demand_month_id, product_id);
