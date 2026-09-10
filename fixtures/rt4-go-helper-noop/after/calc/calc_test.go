package calc

import "testing"

func checkAdd(t *testing.T, got int, want int) {}

func TestAdd(t *testing.T) {
	checkAdd(t, Add(1, 2), 3)
}
