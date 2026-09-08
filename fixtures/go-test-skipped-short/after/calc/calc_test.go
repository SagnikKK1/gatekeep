package calc

import "testing"

func TestAdd(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	if got := Add(2, 3); got != 5 {
		t.Fatalf("Add(2, 3) = %d, want 5", got)
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
