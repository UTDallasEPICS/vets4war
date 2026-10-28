-- Apply explicitly with python -m db.pipeline migrate. No shared DB is altered
-- at application startup. Calls must already exist and generate their own IDs.
CREATE TABLE IF NOT EXISTS pipeline_batches (
    id uuid PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    uploader text NOT NULL,
    month date NOT NULL CHECK (extract(day FROM month) = 1),
    file_hash text NOT NULL,
    contract_hash text NOT NULL,
    source_namespace text NOT NULL,
    status text NOT NULL CHECK (status IN ('invalid', 'validated', 'imported', 'superseded', 'expired')),
    summary jsonb NOT NULL,
    records jsonb,
    imported_at timestamptz,
    imported_by text,
    replaced_batch_id uuid REFERENCES pipeline_batches(id),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    UNIQUE(file_hash, contract_hash, month)
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_one_active_month
    ON pipeline_batches(month) WHERE status = 'imported';
CREATE TABLE IF NOT EXISTS pipeline_call_links (
    source_namespace text NOT NULL,
    source_id text NOT NULL,
    call_id bigint NOT NULL UNIQUE REFERENCES calls(id),
    batch_id uuid NOT NULL REFERENCES pipeline_batches(id),
    PRIMARY KEY (source_namespace, source_id)
);
CREATE INDEX IF NOT EXISTS pipeline_links_batch ON pipeline_call_links(batch_id);
CREATE TABLE IF NOT EXISTS pipeline_jobs (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL UNIQUE REFERENCES pipeline_batches(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'failed')),
    training_status text NOT NULL DEFAULT 'pending',
    report_status text NOT NULL DEFAULT 'pending',
    error_code text,
    attempts integer NOT NULL DEFAULT 0,
    model_version text
);
CREATE TABLE IF NOT EXISTS pipeline_reports (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL UNIQUE REFERENCES pipeline_batches(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    content jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    revision bigint NOT NULL DEFAULT 0
);
INSERT INTO pipeline_state(singleton) VALUES (true) ON CONFLICT DO NOTHING;

-- Supabase can expose public-schema tables through its data API. These tables
-- are backend-only: no browser/data-API access policies are granted.
ALTER TABLE pipeline_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_call_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pipeline_batches,pipeline_call_links,pipeline_jobs,pipeline_reports,pipeline_state FROM PUBLIC;
