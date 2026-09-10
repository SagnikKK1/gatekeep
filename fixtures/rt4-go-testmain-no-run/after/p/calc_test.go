package p

import (
	"testing"
)

func TestMain(m *testing.M) {
}

func TestAdd(t *testing.T) {
	if Add(1, 2) != 3 {
		t.Fatal("bad")
	}
}
