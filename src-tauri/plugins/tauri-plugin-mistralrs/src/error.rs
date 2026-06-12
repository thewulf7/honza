use serde::{Deserialize, Serialize};

/// Stable error codes surfaced to the TypeScript extension so the UI can
/// react to specific failure classes (e.g. OOM vs missing binary).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BinaryNotFound,
    ModelFileNotFound,
    ModelLoadFailed,
    ModelLoadTimedOut,
    OutOfMemory,
    IoError,
    InternalError,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("MistralrsError {{ code: {code:?}, message: \"{message}\" }}")]
pub struct MistralrsError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl MistralrsError {
    pub fn new(code: ErrorCode, message: String, details: Option<String>) -> Self {
        Self {
            code,
            message,
            details,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error(transparent)]
    Mistralrs(#[from] MistralrsError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl serde::Serialize for ServerError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let error: MistralrsError = match self {
            ServerError::Mistralrs(err) => err.clone(),
            ServerError::Io(e) => MistralrsError::new(
                ErrorCode::IoError,
                "An input/output error occurred.".into(),
                Some(e.to_string()),
            ),
            ServerError::Tauri(e) => MistralrsError::new(
                ErrorCode::InternalError,
                "An internal application error occurred.".into(),
                Some(e.to_string()),
            ),
        };
        error.serialize(serializer)
    }
}

pub type ServerResult<T> = Result<T, ServerError>;
