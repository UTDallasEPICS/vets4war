-- Day-range uploads: a batch covers first_day..last_day instead of one month.
-- Apply after 001 with: python -m db.pipeline migrate   (--dry-run to rehearse)
-- Every statement is safe to run again. Batches staged under 001 keep their
-- month and get the matching first_day/last_day; nothing is deleted.
ALTER TABLE pipeline_batches ALTER COLUMN month DROP NOT NULL;
ALTER TABLE pipeline_batches ADD COLUMN IF NOT EXISTS first_day date;
ALTER TABLE pipeline_batches ADD COLUMN IF NOT EXISTS last_day date;
-- The calls a replacement deleted, kept with the batch that replaced them.
ALTER TABLE pipeline_batches ADD COLUMN IF NOT EXISTS replaced_records jsonb;
UPDATE pipeline_batches
   SET first_day = month, last_day = (month + interval '1 month' - interval '1 day')::date
 WHERE month IS NOT NULL AND first_day IS NULL;
-- A batch has both days or neither (a file that could not be read has none).
ALTER TABLE pipeline_batches DROP CONSTRAINT IF EXISTS pipeline_range_order;
ALTER TABLE pipeline_batches ADD CONSTRAINT pipeline_range_order CHECK (
    (first_day IS NULL AND last_day IS NULL)
    OR (first_day IS NOT NULL AND last_day IS NOT NULL AND first_day <= last_day)
);
-- 001's UNIQUE(file_hash, contract_hash, month) and pipeline_one_active_month
-- stay: they only bind rows that still have a month.
