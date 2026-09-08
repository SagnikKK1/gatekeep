package calc

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAdd(t *testing.T) {
	assert.Equal(t, 5, Add(2, 3))
}

func TestDivide(t *testing.T) {
	got, err := Divide(6, 3)
	assert.NoError(t, err)
	assert.Equal(t, 2, got)
}
