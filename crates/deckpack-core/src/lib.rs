//! Deckpack domain core: pack geometry, layout enumeration and holder
//! generation, independent of the desktop shell.
//!
//! Everything here is pure computation over plain data: the Tauri commands,
//! the CLI and the MCP server are thin wrappers around this crate.

pub mod assets;
pub mod library;
pub mod types;

pub use types::*;
