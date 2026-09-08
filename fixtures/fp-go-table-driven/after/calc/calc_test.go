package calc

import "testing"

func TestAdd(t *testing.T) {
	cases := []struct{ a, b, want int }{{2, 3, 5}, {0, 0, 0}}
	for _, tc := range cases {
		if got := Add(tc.a, tc.b); got != tc.want {
			t.Errorf("Add(%d, %d) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestDivide(t *testing.T) {
	got, err := Divide(6, 3)
	if err != nil {
		t.Fatal(err)
	}
	if got != 2 {
		t.Errorf("Divide(6, 3) = %d, want 2", got)
	}
}
