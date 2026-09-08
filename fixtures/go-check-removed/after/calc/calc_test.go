package calc

import "testing"

func TestAdd(t *testing.T) {
	_ = Add(2, 3)
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
