package calc

import "testing"

func checkAdd(t *testing.T, got int, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("got %d, want %d", got, want)
	}
}

func TestAdd(t *testing.T) {
	checkAdd(t, Add(1, 2), 3)
}
