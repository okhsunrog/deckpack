//! Numeric helpers that reproduce JavaScript semantics where they differ from
//! Rust's. Plan ids and lattice keys were defined by the original TypeScript
//! implementation and must keep hashing identically.

/// `Math.round`: halves round toward +∞.
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `Number.prototype.toFixed(digits)`: exact decimal expansion, ties away
/// from zero, and `-0` printed without a sign.
pub fn to_fixed(value: f64, digits: usize) -> String {
    if value == 0.0 {
        return format!("{:.*}", digits, 0.0);
    }
    let negative = value < 0.0;
    // 40 decimals is enough to tell an exact binary tie (…5000…) from a
    // value that merely rounds to one.
    let exact = format!("{:.40}", value.abs());
    let (int_part, frac_part) = exact.split_once('.').unwrap();
    let mut digits_vec: Vec<u8> = int_part
        .bytes()
        .chain(frac_part.bytes().take(digits))
        .map(|b| b - b'0')
        .collect();
    let rest = &frac_part.as_bytes()[digits..];
    // Anything from the exact tie upwards rounds away from zero.
    let round_up = rest[0] >= b'5';
    if round_up {
        let mut index = digits_vec.len();
        loop {
            if index == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            index -= 1;
            if digits_vec[index] == 9 {
                digits_vec[index] = 0;
            } else {
                digits_vec[index] += 1;
                break;
            }
        }
    }
    let split = digits_vec.len() - digits;
    let mut out = String::with_capacity(digits_vec.len() + 2);
    if negative {
        out.push('-');
    }
    for (index, digit) in digits_vec.iter().enumerate() {
        if index == split && digits > 0 {
            out.push('.');
        }
        out.push((b'0' + digit) as char);
    }
    out
}

/// `Math.hypot`: scaled Kahan summation as implemented by JavaScriptCore and
/// V8, so lengths tie-break the same way they did in the browser.
pub fn hypot(values: &[f64]) -> f64 {
    let max = values
        .iter()
        .fold(0.0f64, |max, value| max.max(value.abs()));
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0;
    let mut compensation = 0.0;
    for value in values {
        let scaled = value / max;
        let summand = scaled * scaled - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `(hash * 31 + charCode) | 0` over the UTF-16 code units of the string.
pub fn hash_string(value: &str) -> i32 {
    value.encode_utf16().fold(0i32, |hash, code| {
        hash.wrapping_mul(31).wrapping_add(code as i32)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_javascript() {
        assert_eq!(to_fixed(0.125, 2), "0.13");
        assert_eq!(to_fixed(-0.125, 2), "-0.13");
        assert_eq!(to_fixed(1.005, 2), "1.00"); // 1.005 is below the tie in binary
        assert_eq!(to_fixed(2.5, 0), "3");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(-0.004, 2), "-0.00");
        assert_eq!(to_fixed(9.999, 2), "10.00");
        assert_eq!(to_fixed(339.4, 2), "339.40");
    }

    #[test]
    fn round_and_hash_match_javascript() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(hash_string("x|brick|-|1x3x1|3x2x2|profile"), {
            let mut hash: i32 = 0;
            for byte in "x|brick|-|1x3x1|3x2x2|profile".bytes() {
                hash = hash.wrapping_mul(31).wrapping_add(byte as i32);
            }
            hash
        });
        assert_eq!(hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(hypot(&[0.0, 0.0, 0.0]), 0.0);
    }
}
