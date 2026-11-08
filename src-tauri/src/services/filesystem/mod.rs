//! Filesystem primitives the services share, one topic per submodule, all re-exported here so a
//! caller names `services::filesystem::<item>` whichever file it lives in.

use std::fs;
use std::io::ErrorKind;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::SystemTime;

use crate::utils::hash::file_hash;
use crate::utils::naming::unique_temp_suffix;
use crate::{AppError, AppErrorCode, AppResult};

mod durable;
mod move_file;
mod replace;
mod retry;
mod scan;
mod verified_copy;

pub(crate) use durable::*;
pub(crate) use move_file::*;
pub(crate) use replace::*;
pub(crate) use retry::*;
pub(crate) use scan::*;
pub(crate) use verified_copy::*;

#[cfg(test)]
mod tests;
