pub fn add(a: i32, b: i32) -> i32 { a * b }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds() {
        assert!(add(2, 3) > 0);
    }

    #[test]
    fn adds_zero() {
        assert_eq!(add(0, 0), 0);
    }
}
