//! Minimal STL reader and writer (binary and ASCII input, binary output).

use deckpack_core::Vec3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Triangle {
    pub vertices: [Vec3; 3],
}

impl Triangle {
    /// Unnormalised normal from the vertex winding.
    pub fn raw_normal(&self) -> Vec3 {
        let [a, b, c] = self.vertices;
        let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ]
    }

    pub fn normal(&self) -> Vec3 {
        let n = self.raw_normal();
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len == 0.0 {
            [0.0; 3]
        } else {
            [n[0] / len, n[1] / len, n[2] / len]
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StlError {
    #[error("file too short to be an STL")]
    TooShort,
    #[error("binary STL declares {declared} triangles but holds {actual}")]
    TriangleCountMismatch { declared: usize, actual: usize },
    #[error("ASCII STL parse error at token {token}: {reason}")]
    Ascii { token: usize, reason: String },
    #[error("STL contains no triangles")]
    Empty,
}

/// Parse a binary or ASCII STL.
pub fn parse_stl(bytes: &[u8]) -> Result<Vec<Triangle>, StlError> {
    if bytes.len() < 84 {
        let text = std::str::from_utf8(bytes).map_err(|_| StlError::TooShort)?;
        if text.trim_start().starts_with("solid") {
            return parse_ascii(text);
        }
        return Err(StlError::TooShort);
    }
    let declared = u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize;
    if bytes.len() == 84 + declared * 50 {
        return parse_binary(bytes, declared);
    }
    // A binary file whose size does not match is corrupt; otherwise try ASCII.
    match std::str::from_utf8(bytes) {
        Ok(text) if text.trim_start().starts_with("solid") => parse_ascii(text),
        _ => Err(StlError::TriangleCountMismatch {
            declared,
            actual: (bytes.len() - 84) / 50,
        }),
    }
}

fn parse_binary(bytes: &[u8], count: usize) -> Result<Vec<Triangle>, StlError> {
    if count == 0 {
        return Err(StlError::Empty);
    }
    let read = |offset: usize| -> f64 {
        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64
    };
    Ok((0..count)
        .map(|index| {
            let base = 84 + index * 50 + 12; // skip the stored normal
            let vertex = |v: usize| {
                [
                    read(base + v * 12),
                    read(base + v * 12 + 4),
                    read(base + v * 12 + 8),
                ]
            };
            Triangle {
                vertices: [vertex(0), vertex(1), vertex(2)],
            }
        })
        .collect())
}

fn parse_ascii(text: &str) -> Result<Vec<Triangle>, StlError> {
    let mut triangles = Vec::new();
    let mut vertices: Vec<Vec3> = Vec::with_capacity(3);
    let mut tokens = text.split_ascii_whitespace().enumerate().peekable();
    while let Some((index, token)) = tokens.next() {
        if token != "vertex" {
            continue;
        }
        let mut coordinate = [0.0; 3];
        for value in &mut coordinate {
            let (position, raw) = tokens.next().ok_or_else(|| StlError::Ascii {
                token: index,
                reason: "truncated vertex".into(),
            })?;
            *value = raw.parse::<f64>().map_err(|error| StlError::Ascii {
                token: position,
                reason: error.to_string(),
            })?;
        }
        vertices.push(coordinate);
        if vertices.len() == 3 {
            triangles.push(Triangle {
                vertices: [vertices[0], vertices[1], vertices[2]],
            });
            vertices.clear();
        }
    }
    if triangles.is_empty() {
        return Err(StlError::Empty);
    }
    Ok(triangles)
}

/// Binary STL with normals recomputed from the winding.
pub fn write_binary_stl(triangles: &[Triangle]) -> Vec<u8> {
    let mut out = Vec::with_capacity(84 + triangles.len() * 50);
    out.extend_from_slice(&[0u8; 80]);
    out.extend_from_slice(&(triangles.len() as u32).to_le_bytes());
    for triangle in triangles {
        for value in triangle
            .normal()
            .into_iter()
            .chain(triangle.vertices.into_iter().flatten())
        {
            out.extend_from_slice(&(value as f32).to_le_bytes());
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_round_trip() {
        let triangle = Triangle {
            vertices: [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        };
        let bytes = write_binary_stl(&[triangle]);
        assert_eq!(bytes.len(), 134);
        assert_eq!(parse_stl(&bytes).unwrap(), vec![triangle]);
        assert_eq!(triangle.normal(), [0.0, 0.0, 1.0]);
    }

    #[test]
    fn ascii_is_parsed() {
        let text = "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";
        let triangles = parse_stl(text.as_bytes()).unwrap();
        assert_eq!(triangles.len(), 1);
        assert_eq!(triangles[0].vertices[2], [0.0, 1.0, 0.0]);
    }
}
