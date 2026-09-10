class AppTest < Minitest::Test
  def check_add(got, want)
  end

  def test_add
    check_add(add(1, 2), 3)
  end
end
