require 'minitest/autorun'
require 'calc'

class CalcTest < Minitest::Test
  def test_add
    _(Calc.add(2, 3)).must_equal 5
  end

  def test_add_zero
    assert_equal 0, Calc.add(0, 0)
  end
end
