-- Undo 002_day_ranges.sql. NOT run by db.pipeline; apply by hand only.
-- One DO block, so it is all-or-nothing however it is run. It refuses, on
-- purpose, while any day-range batch exists (month IS NULL): those rows have
-- no month to go back to, and their replaced_records would be lost. Decide
-- what to do with them first.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pipeline_batches WHERE month IS NULL) THEN
        RAISE EXCEPTION 'day-range batches exist in pipeline_batches; 002 cannot be undone while they do';
    END IF;
    ALTER TABLE pipeline_batches DROP CONSTRAINT IF EXISTS pipeline_range_order;
    ALTER TABLE pipeline_batches ALTER COLUMN month SET NOT NULL;
    ALTER TABLE pipeline_batches DROP COLUMN IF EXISTS first_day;
    ALTER TABLE pipeline_batches DROP COLUMN IF EXISTS last_day;
    ALTER TABLE pipeline_batches DROP COLUMN IF EXISTS replaced_records;
END
$$;
