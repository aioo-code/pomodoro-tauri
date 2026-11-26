use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Focus,
    Break,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ready,
    Running,
    Paused,
    Completed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub adjusted: bool,
    pub mode: Mode,
    pub status: Status,
    pub remaining_ms: u64,
    pub duration_ms: u64,
    pub revision: u64,
    pub test_mode: bool,
    pub selected_minutes: u64,
    pub focus_minutes: u64,
    pub break_minutes: u64,
}

struct Phase {
    total: Duration,
    adjusted: bool,
    minutes: u64,
    remaining: Duration,
    status: Status,
    deadline: Option<Instant>,
}
pub struct Timer {
    mode: Mode,
    phases: [Phase; 2],
    revision: u64,
    test_seconds: Option<u64>,
}
impl Timer {
    pub fn new(test_seconds: Option<u64>) -> Self {
        let phase = |minutes| Phase {
            total: Duration::from_secs(test_seconds.unwrap_or(minutes * 60)),
            adjusted: false,
            minutes,
            remaining: Duration::from_secs(test_seconds.unwrap_or(minutes * 60)),
            status: Status::Ready,
            deadline: None,
        };
        Self {
            mode: Mode::Focus,
            phases: [phase(25), phase(5)],
            revision: 0,
            test_seconds,
        }
    }
    fn index(&self) -> usize {
        if self.mode == Mode::Focus {
            0
        } else {
            1
        }
    }
    fn duration(&self) -> Duration {
        self.phases[self.index()].total
    }
    fn reset(&mut self) {
        let remaining = self.duration();
        let index = self.index();
        let phase = &mut self.phases[index];
        phase.remaining = remaining;
        phase.status = Status::Ready;
        phase.deadline = None;
    }
    pub fn set_minutes(&mut self, minutes: u64) -> Result<(), &'static str> {
        if !(1..=1440).contains(&minutes) {
            return Err("请输入 1–1440 的整数分钟。");
        }
        let index = self.index();
        // Re-selecting a duration must never discard a running or paused countdown.
        if self.phases[index].minutes == minutes && !self.phases[index].adjusted {
            return Ok(());
        }
        self.phases[index].minutes = minutes;
        self.phases[index].total = Duration::from_secs(self.test_seconds.unwrap_or(minutes * 60));
        self.phases[index].adjusted = false;
        self.reset();
        self.revision += 1;
        Ok(())
    }
    pub fn tick(&mut self, now: Instant) -> bool {
        let index = self.index();
        let phase = &mut self.phases[index];
        if phase.status != Status::Running {
            return false;
        }
        phase.remaining = phase.deadline.unwrap().saturating_duration_since(now);
        if phase.remaining.is_zero() {
            phase.status = Status::Completed;
            phase.deadline = None;
            self.revision += 1;
            return true;
        }
        false
    }
    pub fn adjust_remaining(
        &mut self,
        milliseconds: u64,
        now: Instant,
    ) -> Result<(), &'static str> {
        if !(1000..=86_400_000).contains(&milliseconds) {
            return Err("剩余时间请设置为 1 秒至 24 小时。");
        }
        self.tick(now);
        let phase = &mut self.phases[self.index()];
        let remaining = Duration::from_millis(milliseconds);
        let elapsed = if phase.status == Status::Completed {
            Duration::ZERO
        } else {
            phase.total.saturating_sub(phase.remaining)
        };
        phase.total = elapsed + remaining;
        phase.remaining = remaining;
        phase.adjusted = true;
        if phase.status == Status::Running {
            phase.deadline = Some(now + remaining);
        } else {
            phase.deadline = None;
            if phase.status == Status::Completed {
                phase.status = Status::Ready;
            }
        }
        self.revision += 1;
        Ok(())
    }
    pub fn action(&mut self, action: &str, now: Instant) -> Result<(), &'static str> {
        let index = self.index();
        let duration = self.duration();
        match action {
            "start" => {
                let phase = &mut self.phases[index];
                if phase.status == Status::Running {
                    return Ok(());
                }
                if phase.status == Status::Completed {
                    phase.remaining = duration;
                }
                phase.deadline = Some(now + phase.remaining);
                phase.status = Status::Running;
            }
            "pause" => {
                let phase = &mut self.phases[index];
                if phase.status != Status::Running {
                    return Ok(());
                }
                phase.remaining = phase.deadline.unwrap().saturating_duration_since(now);
                phase.deadline = None;
                phase.status = if phase.remaining.is_zero() {
                    Status::Completed
                } else {
                    Status::Paused
                };
            }
            "reset" => self.reset(),
            "focus" | "break" => {
                let next = if action == "focus" {
                    Mode::Focus
                } else {
                    Mode::Break
                };
                if next == self.mode {
                    return Ok(());
                }
                // One timer runs at a time. Save each tab's exact progress and state.
                self.action("pause", now)?;
                self.mode = next;
            }
            _ => return Err("不支持的操作，请重试。"),
        }
        self.revision += 1;
        Ok(())
    }
    pub fn snapshot(&self) -> Snapshot {
        let phase = &self.phases[self.index()];
        Snapshot {
            adjusted: phase.adjusted,
            mode: self.mode,
            status: phase.status,
            remaining_ms: phase.remaining.as_millis() as u64,
            duration_ms: self.duration().as_millis() as u64,
            revision: self.revision,
            test_mode: self.test_seconds.is_some(),
            selected_minutes: phase.minutes,
            focus_minutes: self.phases[0].minutes,
            break_minutes: self.phases[1].minutes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adjustment_preserves_elapsed_running_deadline_and_other_phase() {
        let now = Instant::now();
        let mut timer = Timer::new(None);
        timer.action("start", now).unwrap();
        timer
            .adjust_remaining(600_000, now + Duration::from_secs(12))
            .unwrap();
        let snapshot = timer.snapshot();
        assert_eq!(snapshot.status, Status::Running);
        assert!(snapshot.adjusted);
        assert_eq!(snapshot.duration_ms, 612_000);
        assert_eq!(snapshot.remaining_ms, 600_000);
        timer.tick(now + Duration::from_secs(13));
        assert_eq!(timer.snapshot().remaining_ms, 599_000);
        timer
            .action("break", now + Duration::from_secs(13))
            .unwrap();
        assert_eq!(timer.snapshot().remaining_ms, 300_000);
        timer
            .action("focus", now + Duration::from_secs(14))
            .unwrap();
        assert_eq!(timer.snapshot().status, Status::Paused);
        assert_eq!(timer.snapshot().remaining_ms, 599_000);
        timer
            .adjust_remaining(900_000, now + Duration::from_secs(15))
            .unwrap();
        assert_eq!(timer.snapshot().status, Status::Paused);
        assert_eq!(timer.snapshot().duration_ms, 913_000);
        timer.set_minutes(25).unwrap();
        assert!(!timer.snapshot().adjusted);
        assert_eq!(timer.snapshot().remaining_ms, 1_500_000);
    }
    #[test]
    fn invalid_adjustments_do_not_mutate_and_shortening_completes_once() {
        let now = Instant::now();
        let mut timer = Timer::new(None);
        let revision = timer.snapshot().revision;
        for value in [0, 999, 86_400_001] {
            assert!(timer.adjust_remaining(value, now).is_err());
        }
        assert_eq!(timer.snapshot().revision, revision);
        timer.action("start", now).unwrap();
        timer
            .adjust_remaining(1000, now + Duration::from_secs(1))
            .unwrap();
        assert!(!timer.tick(now + Duration::from_millis(1999)));
        assert!(timer.tick(now + Duration::from_secs(2)));
        assert!(!timer.tick(now + Duration::from_secs(3)));
        timer
            .adjust_remaining(3000, now + Duration::from_secs(4))
            .unwrap();
        assert_eq!(timer.snapshot().status, Status::Ready);
        assert_eq!(timer.snapshot().duration_ms, 3000);
    }
    #[test]
    fn tabs_preserve_exact_progress_and_do_not_run_together() {
        let now = Instant::now();
        let mut t = Timer::new(None);
        t.action("start", now).unwrap();
        t.action("break", now + Duration::from_millis(1234))
            .unwrap();
        assert_eq!(t.snapshot().remaining_ms, 300_000);
        t.action("start", now + Duration::from_secs(2)).unwrap();
        t.action("focus", now + Duration::from_secs(4)).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 1_498_766);
        assert_eq!(t.snapshot().status, Status::Paused);
        t.tick(now + Duration::from_secs(20));
        assert_eq!(t.snapshot().remaining_ms, 1_498_766);
        t.action("break", now + Duration::from_secs(21)).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 298_000);
        assert_eq!(t.snapshot().status, Status::Paused);
    }
    #[test]
    fn selecting_current_tab_or_duration_is_a_noop() {
        let now = Instant::now();
        let mut t = Timer::new(None);
        t.action("start", now).unwrap();
        let revision = t.revision;
        t.action("focus", now + Duration::from_secs(1)).unwrap();
        t.set_minutes(25).unwrap();
        assert_eq!(t.revision, revision);
        assert_eq!(t.snapshot().status, Status::Running);
        t.tick(now + Duration::from_secs(2));
        assert_eq!(t.snapshot().remaining_ms, 1_498_000);
    }
    #[test]
    fn presets_only_reset_the_selected_phase() {
        let now = Instant::now();
        let mut t = Timer::new(None);
        t.action("start", now).unwrap();
        t.action("break", now + Duration::from_secs(7)).unwrap();
        for minutes in [5, 10, 15, 25, 30, 45, 60] {
            t.set_minutes(minutes).unwrap();
            assert_eq!(t.snapshot().remaining_ms, minutes * 60_000);
        }
        t.action("focus", now).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 1_493_000);
        t.action("reset", now).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 1_500_000);
        t.action("break", now).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 3_600_000);
        assert!(t.set_minutes(0).is_err());
        assert!(t.set_minutes(1441).is_err());
    }
    #[test]
    fn pause_resume_reset_preserves_milliseconds() {
        let now = Instant::now();
        let mut t = Timer::new(None);
        t.action("start", now).unwrap();
        t.action("pause", now + Duration::from_millis(1250))
            .unwrap();
        assert_eq!(t.snapshot().remaining_ms, 1_498_750);
        t.tick(now + Duration::from_secs(100));
        assert_eq!(t.snapshot().remaining_ms, 1_498_750);
        t.action("start", now + Duration::from_secs(100)).unwrap();
        t.tick(now + Duration::from_millis(100750));
        assert_eq!(t.snapshot().remaining_ms, 1_498_000);
        t.action("reset", now).unwrap();
        assert_eq!(t.snapshot().status, Status::Ready);
    }
    #[test]
    fn completion_is_once_and_survives_tab_switch_until_restart() {
        let now = Instant::now();
        let mut t = Timer::new(Some(2));
        t.action("start", now).unwrap();
        assert!(t.tick(now + Duration::from_secs(20)));
        assert!(!t.tick(now + Duration::from_secs(200)));
        t.action("break", now).unwrap();
        t.action("focus", now).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 0);
        assert_eq!(t.snapshot().status, Status::Completed);
        t.action("start", now).unwrap();
        assert_eq!(t.snapshot().remaining_ms, 2000);
    }
    #[test]
    fn repeated_start_and_invalid_input_do_not_change_deadline() {
        let now = Instant::now();
        let mut t = Timer::new(Some(2));
        t.action("start", now).unwrap();
        t.action("start", now + Duration::from_secs(1)).unwrap();
        assert!(t.tick(now + Duration::from_secs(2)));
        let revision = t.revision;
        assert!(t.action("invalid", now).is_err());
        assert_eq!(t.revision, revision);
    }
}
#[test]
fn custom_minutes_preserve_independent_phase_progress_and_reselection_is_a_noop() {
    let now = Instant::now();
    let mut timer = Timer::new(None);
    timer.set_minutes(17).unwrap();
    timer.action("start", now).unwrap();
    timer.action("break", now + Duration::from_secs(5)).unwrap();
    timer.set_minutes(1440).unwrap();
    assert_eq!(timer.snapshot().duration_ms, 86_400_000);
    timer.action("focus", now + Duration::from_secs(6)).unwrap();
    let before = timer.snapshot();
    assert_eq!(before.remaining_ms, 1_015_000);
    timer.set_minutes(17).unwrap();
    assert_eq!(timer.snapshot().revision, before.revision);
    assert_eq!(timer.snapshot().remaining_ms, before.remaining_ms);
    assert!(timer.set_minutes(1441).is_err());
}
