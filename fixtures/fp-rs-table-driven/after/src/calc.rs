pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_cases() {
        for (a, b, want) in [(2, 3, 5), (0, 0, 0)] {
            assert_eq!(add(a, b), want);
        }
    }
}
