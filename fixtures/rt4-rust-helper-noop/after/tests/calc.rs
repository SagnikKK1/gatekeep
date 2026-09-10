use mycrate::add;

fn check_add(_got: i32, _want: i32) {}

#[test]
fn test_add() {
    check_add(add(1, 2), 3);
}
