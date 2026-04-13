-- Remove duplicate rows, keeping only the first inserted (lowest id) for each unique combo
DELETE FROM health_metrics
WHERE id NOT IN (
  SELECT MIN(id) FROM health_metrics
  GROUP BY metric, date, timestamp, value
);

-- Add unique constraint to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_metric_point
ON health_metrics(metric, date, timestamp, value);
