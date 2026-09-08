package calc

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestAdd(t *testing.T) {
	assert.InDelta(t, 5, Add(2, 3), 1000)
}
