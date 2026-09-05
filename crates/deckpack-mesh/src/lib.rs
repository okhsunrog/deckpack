//! Turn an enclosure STL into the sampled inner surface the planner works
//! with, plus a display mesh in app coordinates.
//!
//! The pipeline reproduces the one that generated the bundled Spark case:
//! vertical rays from the open side hit the first surface facing them, the
//! depth is quantised to `u8` steps and packed row-major.

pub mod depth;
pub mod export;
pub mod holder_csg;
pub mod import;
pub mod stl;

pub use depth::DepthMapOptions;
pub use export::cells_stl;
pub use holder_csg::{CsgOptions, CsgPiece, CsgReport, RailSpan, build_piece};
pub use import::{ImportError, ImportOptions, ImportedEnclosure, import_enclosure_stl};
pub use stl::{StlError, Triangle, parse_stl, write_binary_stl};
