package calc

import "testing"

func TestAdd(t *testing.T) {
	t.Run("positive", func(t *testing.T) {
		if got := Add(2, 3); got != 5 {
			t.Fatalf("Add(2, 3) = %d, want 5", got)
		}
	})
	t.Run("zero", func(t *testing.T) {
		if got := Add(0, 0); got != 0 {
			t.Fatalf("got %d", got)
		}
	})
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
