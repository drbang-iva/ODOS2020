ALTER TABLE odos_package_redemptions
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
