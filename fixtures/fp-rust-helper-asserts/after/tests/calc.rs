use mycrate::add;

fn check_add(got: i32, want: i32) {
    assert_eq!(got, want);
}

#[test]
fn test_add() {
    check_add(add(1, 2), 3);
}
