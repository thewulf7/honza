use std::process::Child;
use tokio::sync::Mutex;

/// Holds the child process handles for the voice servers.
#[derive(Default)]
pub struct VoiceProcesses {
    pub whisper: Option<Child>,
    pub kokoro: Option<Child>,
    pub qwen3tts: Option<Child>,
}

impl VoiceProcesses {
    pub fn kill_whisper(&mut self) {
        if let Some(mut child) = self.whisper.take() {
            let _ = child.kill();
        }
    }

    pub fn kill_kokoro(&mut self) {
        if let Some(mut child) = self.kokoro.take() {
            let _ = child.kill();
        }
    }

    pub fn kill_qwen3tts(&mut self) {
        if let Some(mut child) = self.qwen3tts.take() {
            let _ = child.kill();
        }
    }

    /// Returns true if the whisper child process is alive (has not exited).
    pub fn is_whisper_running(&mut self) -> bool {
        if let Some(child) = self.whisper.as_mut() {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }

    /// Returns true if the kokoro child process is alive.
    pub fn is_kokoro_running(&mut self) -> bool {
        if let Some(child) = self.kokoro.as_mut() {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }

    /// Returns true if the qwen3tts child process is alive.
    pub fn is_qwen3tts_running(&mut self) -> bool {
        if let Some(child) = self.qwen3tts.as_mut() {
            matches!(child.try_wait(), Ok(None))
        } else {
            false
        }
    }
}

/// Managed state wrapper (Arc<Mutex<…>> lives in AppState).
pub type SharedVoiceProcesses = std::sync::Arc<Mutex<VoiceProcesses>>;
