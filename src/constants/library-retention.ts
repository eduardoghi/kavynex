// How many days the library keeps what it moved aside to its `.trash` folder, and how long orphan
// removal stays off after a database import or restore. The backend's `ORPHAN_GRACE_PERIOD`
// decides both, and `shared/orphan-grace-period.json` holds the two sides to the same number.
export const ORPHAN_GRACE_PERIOD_DAYS = 30;
