use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::{Semaphore, SemaphorePermit};

use crate::{AppError, AppErrorCode, AppResult};

/// A concurrency gate that bounds both how many callers run at once *and* how many may be waiting to
/// run. A bare `tokio::Semaphore` bounds only the former. `acquire()` enqueues an unbounded number of
/// waiters, so a caller firing the guarded operation in a tight loop (a buggy or compromised frontend
/// issuing a yt-dlp IPC command with fresh run ids) can pile up an arbitrarily deep backlog ahead of
/// a later, legitimate request. Starving it even though only a couple of operations ever run
/// concurrently. This pairs the semaphore with an in-flight counter and refuses a new caller once
/// `max_in_flight` are already holding-or-awaiting a permit, turning that unbounded backlog into an
/// immediate, distinct error. The ceiling is set generously (well above real interactive/bulk use),
/// so it only ever trips on abuse; a waiting caller has not spawned its process yet, so the queue it
/// bounds costs a parked task, not a running yt-dlp tree.
pub struct BoundedSemaphore {
    semaphore: Semaphore,
    in_flight: AtomicUsize,
    max_in_flight: usize,
}

impl BoundedSemaphore {
    /// `permits` is how many callers run concurrently; `max_in_flight` is the hard ceiling on
    /// running-plus-waiting callers. Pass `max_in_flight >= permits`. A ceiling below the
    /// concurrency would reject callers a free permit could still serve.
    pub const fn new(permits: usize, max_in_flight: usize) -> Self {
        Self {
            semaphore: Semaphore::const_new(permits),
            in_flight: AtomicUsize::new(0),
            max_in_flight,
        }
    }

    /// Reserves an in-flight slot (bounded) and then awaits an execution permit. Returns
    /// `too_busy_code` immediately, without queuing, when `max_in_flight` callers are already in
    /// flight. The returned guard holds the permit for the caller's whole operation and releases the
    /// slot when dropped, on every exit path.
    pub async fn acquire(
        &'static self,
        too_busy_code: AppErrorCode,
    ) -> AppResult<BoundedSemaphorePermit> {
        // Claim a slot up front. `fetch_add` returns the prior count, so a prior value at or above
        // the ceiling means the slot is not ours. Roll it back and reject before ever queuing on
        // the semaphore.
        let previous = self.in_flight.fetch_add(1, Ordering::SeqCst);
        if previous >= self.max_in_flight {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return Err(AppError::from_code(
                too_busy_code,
                "too many concurrent operations are already in progress",
            ));
        }

        // The slot is reserved; on the (practically impossible) permit-acquire failure, give the
        // slot back so a closed semaphore cannot leak the count. A 'static semaphore is never closed.
        match self.semaphore.acquire().await {
            Ok(permit) => Ok(BoundedSemaphorePermit {
                _permit: permit,
                in_flight: &self.in_flight,
            }),
            Err(_) => {
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                Err(AppError::from_code(
                    too_busy_code,
                    "the concurrency gate is unavailable",
                ))
            }
        }
    }

    #[cfg(test)]
    fn in_flight_count(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }
}

/// Releases the in-flight slot (and the underlying permit) when dropped, on every exit path of the
/// guarded operation.
#[derive(Debug)]
pub struct BoundedSemaphorePermit {
    _permit: SemaphorePermit<'static>,
    in_flight: &'static AtomicUsize,
}

impl Drop for BoundedSemaphorePermit {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test owns a distinct `static` gate so the process-global in-flight counter cannot be
    // perturbed by another test running in parallel. `permits == max_in_flight` here so every
    // in-flight caller also holds a permit (none block awaiting one), which keeps the ceiling test
    // deterministic without spawning tasks to occupy the queue.
    const BUSY: AppErrorCode = AppErrorCode::TooManyConcurrentYtDlpRuns;

    #[tokio::test]
    async fn acquire_succeeds_below_the_ceiling_and_tracks_in_flight() {
        static GATE: BoundedSemaphore = BoundedSemaphore::new(2, 2);

        let first = GATE.acquire(BUSY).await.unwrap();
        assert_eq!(GATE.in_flight_count(), 1);
        let second = GATE.acquire(BUSY).await.unwrap();
        assert_eq!(GATE.in_flight_count(), 2);

        drop(first);
        drop(second);
        assert_eq!(GATE.in_flight_count(), 0);
    }

    #[tokio::test]
    async fn acquire_rejects_once_the_ceiling_is_reached_and_rolls_the_slot_back() {
        static GATE: BoundedSemaphore = BoundedSemaphore::new(2, 2);

        let _a = GATE.acquire(BUSY).await.unwrap();
        let _b = GATE.acquire(BUSY).await.unwrap();

        let rejected = GATE.acquire(BUSY).await.unwrap_err();
        assert_eq!(rejected.code, BUSY.as_str());
        // The rejected caller must not leave its optimistic increment behind.
        assert_eq!(GATE.in_flight_count(), 2);
    }

    #[tokio::test]
    async fn dropping_a_permit_frees_a_slot_for_a_new_caller() {
        static GATE: BoundedSemaphore = BoundedSemaphore::new(2, 2);

        let a = GATE.acquire(BUSY).await.unwrap();
        let _b = GATE.acquire(BUSY).await.unwrap();
        assert!(GATE.acquire(BUSY).await.is_err());

        drop(a);
        // The freed slot admits exactly one more caller.
        let _c = GATE.acquire(BUSY).await.unwrap();
        assert_eq!(GATE.in_flight_count(), 2);
    }
}
