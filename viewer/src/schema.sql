CREATE TABLE IF NOT EXISTS podpings (
  id          BIGSERIAL PRIMARY KEY,
  tx_id       TEXT NOT NULL,
  op_idx      INT  NOT NULL,
  block_num   BIGINT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  signer      TEXT NOT NULL,
  op_id       TEXT NOT NULL,
  medium      TEXT,
  reason      TEXT,
  iris        TEXT[] NOT NULL,
  raw         JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_id, op_idx)
);
CREATE INDEX IF NOT EXISTS podpings_ts_idx ON podpings (ts DESC);
CREATE INDEX IF NOT EXISTS podpings_ts_id_idx ON podpings (ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS podpings_signer_idx ON podpings (signer);
CREATE INDEX IF NOT EXISTS podpings_op_id_idx ON podpings (op_id);

CREATE TABLE IF NOT EXISTS podping_iris (
  podping_id  BIGINT NOT NULL REFERENCES podpings(id) ON DELETE CASCADE,
  iri         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS podping_iris_iri_idx ON podping_iris (iri);
CREATE INDEX IF NOT EXISTS podping_iris_podping_idx ON podping_iris (podping_id);

CREATE TABLE IF NOT EXISTS feeds (
  iri          TEXT PRIMARY KEY,
  pi_feed_id   BIGINT,
  title        TEXT,
  author       TEXT,
  image        TEXT,
  medium       TEXT,
  last_checked TIMESTAMPTZ,
  not_found    BOOLEAN NOT NULL DEFAULT false
);
