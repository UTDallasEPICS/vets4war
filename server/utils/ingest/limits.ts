// What one uploaded workbook may cost to read. The byte and row limits of the upload
// itself come from the environment (V4W_UPLOAD_MAX_MB, V4W_UPLOAD_MAX_ROWS); these bound
// the archive behind it, so a small file cannot unpack to, or point at, far more.

// A call-records workbook has a few dozen parts; 2,000 leaves room for anything Excel
// writes and still refuses an archive stuffed with entries.
export const MAX_ARCHIVE_ENTRIES = 2000

// The 420,000-row spike workbook (six years on six sheets) unpacks to 153 MB; 600 MB is
// four times that and still bounded by the disk and time one upload may take.
export const MAX_UNPACKED_BYTES = 600 * 1024 * 1024

// The partner's layouts have at most a handful of sheets (one per year in the
// multi-year export).
export const MAX_SHEETS = 32

// The workbook part and its relationships are read by hand to name the sheets; real ones
// are a few kilobytes.
export const MAX_WORKBOOK_PART_BYTES = 4 * 1024 * 1024

// Rows go to the stage, and back to the caller, in batches of this size (PLAN.md 6:
// staging rows are written in chunks of 5,000 rows per transaction).
export const ROW_BATCH = 5000

// Messages list at most this many days or Excel rows, then "and <n> more".
export const MAX_LISTED = 10

// Ready uploads that nobody imported are discarded after this long.
export const STAGED_DAYS = 7
